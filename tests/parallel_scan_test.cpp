#include <cerrno>
#include <cstdio>
#include <filesystem>
#include <functional>
#include <map>
#include <pthread.h>
#include <sys/resource.h>

static std::function<void(const char*, int, const char*)> checkpoint;
static void scan_checkpoint(const char* event, int parent, const char* name) {
    if (checkpoint) checkpoint(event, parent, name);
}
static int create_calls = 0;
static int fail_after = -1;
static int create_thread(pthread_t* thread, const pthread_attr_t* attr,
                         void* (*entry)(void*), void* context) {
    if (fail_after >= 0 && create_calls++ >= fail_after) return EAGAIN;
    return pthread_create(thread, attr, entry, context);
}
#define SOCKETSWEEP_SCAN_CHECKPOINT scan_checkpoint
#define SOCKETSWEEP_SCAN_CREATE_THREAD create_thread
#define main daemon_main
#include "../engine/daemon.cpp"
#undef main

static void require(bool ok, const char* message) {
    if (!ok) { std::fprintf(stderr, "%s\n", message); std::exit(1); }
}
struct Fixture {
    std::string path;
    Fixture() {
        char pattern[] = "/tmp/socketsweep-parallel-XXXXXX";
        char* created = ::mkdtemp(pattern);
        require(created != nullptr, "mkdtemp failed");
        path = created;
    }
    ~Fixture() { std::error_code error; std::filesystem::remove_all(path, error); }
    std::string dir(const std::string& name) {
        const auto value = path + '/' + name;
        require(::mkdir(value.c_str(), 0700) == 0, "mkdir failed");
        return value;
    }
    void file(const std::string& name, size_t size) {
        const auto value = path + '/' + name;
        safe_delete::Fd fd(::open(value.c_str(), O_CREAT | O_WRONLY | O_EXCL | O_CLOEXEC, 0600));
        require(fd.get() >= 0 && ::ftruncate(fd.get(), static_cast<off_t>(size)) == 0,
                "file creation failed");
    }
};
struct Snapshot {
    FileNode tree;
    ScanStats stats;
    parallel_scan::Result result;
};
static Snapshot run(const std::string& path, int workers) {
    safe_delete::Root root;
    require(root.open(path), "root open failed");
    Snapshot snapshot;
    snapshot.tree.name = path.substr(path.rfind('/') + 1);
    snapshot.tree.path = path;
    snapshot.tree.is_dir = true;
    snapshot.tree.device = root.identity.st_dev;
    snapshot.tree.inode = root.identity.st_ino;
    snapshot.result = parallel_scan::run(root, snapshot.tree, snapshot.stats, workers, cfg::MAX_DEPTH);
    require(snapshot.result.workers >= 1 && snapshot.result.workers <= workers,
            "worker count out of bounds");
    require(snapshot.result.queue_peak <= parallel_scan::MAX_PENDING, "queue exceeded bound");
    return snapshot;
}
using Entries = std::map<std::string, std::pair<bool, int64_t>>;
static void flatten(const FileNode& node, Entries& entries) {
    require(entries.emplace(node.path, std::make_pair(node.is_dir, node.size)).second,
            "duplicate output path");
    for (const auto& child : node.children) flatten(child, entries);
    for (size_t i = 1; i < node.children.size(); ++i) {
        require(node.children[i-1].size >= node.children[i].size, "children are not size-sorted");
    }
}
static void same(const Snapshot& actual, const FileNode& expected, const ScanStats& stats) {
    Entries a, b;
    flatten(actual.tree, a);
    flatten(expected, b);
    require(a == b, "parallel tree differs from serial reference");
    require(actual.stats.files == stats.files && actual.stats.dirs == stats.dirs &&
            actual.stats.total_size == stats.total_size && actual.stats.errors == stats.errors &&
            actual.stats.skipped == stats.skipped, "parallel statistics differ from serial reference");
}
static void equivalence() {
    Fixture fixture;
    for (int d = 0; d < 180; ++d) {
        const std::string dir = "album " + std::to_string(d);
        fixture.dir(dir);
        fixture.dir(dir + "/empty");
        for (int i = 0; i < 12; ++i) fixture.file(dir + "/file " + std::to_string(i), d + i);
    }
    fixture.file(".hidden", 17);
    fixture.file(" leading and trailing ", 29);
    fixture.file("quote\"line\n", 31);
    require(::link((fixture.path + "/.hidden").c_str(), (fixture.path + "/hard-link").c_str()) == 0,
            "hard link creation failed");
    require(::symlink("album 0", (fixture.path + "/dir-link").c_str()) == 0, "symlink failed");
    require(::symlink(".hidden", (fixture.path + "/file-link").c_str()) == 0, "symlink failed");
    require(::mkfifo((fixture.path + "/fifo").c_str(), 0600) == 0, "fifo failed");
#if defined(__linux__)
    fixture.file(std::string("nonutf-") + '\xff', 41);
#endif
    ScanStats stats;
    g_read_only = false;
    FileNode expected = scan(fixture.path, fixture.path.substr(fixture.path.rfind('/') + 1), stats, 0);
    for (int workers : {1, 2, 4, 8}) {
        for (int repeat = 0; repeat < 3; ++repeat) same(run(fixture.path, workers), expected, stats);
    }
}
static void depth() {
    Fixture fixture;
    std::string path;
    for (int level = 0; level < 67; ++level) {
        fixture.file(path + (path.empty() ? "" : "/") + "file", level);
        path += (path.empty() ? "" : "/") + std::string("next");
        fixture.dir(path);
    }
    ScanStats stats;
    const auto name = fixture.path.substr(fixture.path.rfind('/') + 1);
    FileNode expected = scan(fixture.path, name, stats, 0);
    require(stats.errors == 1 && stats.dirs == 65 && stats.files == 64, "bad depth fixture");
    for (int workers : {1, 4, 8}) same(run(fixture.path, workers), expected, stats);
}
static void replacement(const std::string& kind) {
    Fixture fixture;
    fixture.dir("root");
    fixture.dir("root/selected");
    fixture.file("root/selected/original", 3);
    fixture.dir("outside");
    fixture.file("outside/secret", 1000000);
    bool fired = false;
    std::mutex barrier;
    checkpoint = [&](const char* event, int, const char* name) {
        std::lock_guard<std::mutex> lock(barrier);
        const bool match = kind == "opened" ?
            std::string(event) == "opened" && std::string(name) == fixture.path + "/root/selected" :
            std::string(event) == "before_open" && std::string(name) == "selected";
        if (fired || !match) return;
        fired = true;
        require(::rename((fixture.path + "/root/selected").c_str(), (fixture.path + "/moved").c_str()) == 0,
                "race rename failed");
        if (kind == "inode") {
            fixture.dir("root/selected");
            fixture.file("root/selected/replacement", 1000000);
        } else {
            require(::symlink((fixture.path + "/outside").c_str(),
                              (fixture.path + "/root/selected").c_str()) == 0, "race symlink failed");
        }
    };
    const auto snapshot = run(fixture.path + "/root", 4);
    checkpoint = {};
    require(fired, "race checkpoint not reached");
    require(snapshot.stats.total_size == (kind == "opened" ? 3 : 0), "replacement data scanned");
    require(snapshot.stats.errors == (kind == "opened" ? 0 : 1), "replacement error not reported");
}
static size_t descriptors() {
    DIR* dir = ::opendir("/dev/fd");
    require(dir != nullptr, "descriptor listing failed");
    size_t count = 0;
    while (auto* entry = ::readdir(dir)) if (entry->d_name[0] != '.') ++count;
    ::closedir(dir);
    return count;
}
static void resources() {
    Fixture fixture;
    for (int i = 0; i < 800; ++i) {
        const auto dir = std::to_string(i);
        fixture.dir(dir);
        fixture.file(dir + "/file", 7);
    }
    struct rlimit saved{};
    require(::getrlimit(RLIMIT_NOFILE, &saved) == 0, "getrlimit failed");
    struct rlimit limited = saved;
    limited.rlim_cur = std::min<rlim_t>(saved.rlim_cur, 32);
    require(::setrlimit(RLIMIT_NOFILE, &limited) == 0, "setrlimit failed");
    const size_t before = descriptors();
    const auto serial = run(fixture.path, 1);
    require(serial.result.queue_peak == parallel_scan::MAX_PENDING && serial.stats.files == 800,
            "queue saturation fallback lost work");
    for (int i = 0; i < 8; ++i) {
        const auto snapshot = run(fixture.path, 8);
        require(snapshot.stats.files == 800 && snapshot.stats.total_size == 5600 &&
                snapshot.stats.errors == 0, "low-descriptor scan failed");
    }
    require(descriptors() == before, "scan leaked descriptors");
    require(::setrlimit(RLIMIT_NOFILE, &saved) == 0, "restore rlimit failed");
    for (int failure : {0, 2}) {
        fail_after = failure;
        create_calls = 0;
        const auto snapshot = run(fixture.path, 8);
        require(snapshot.result.workers == failure + 1, "worker creation fallback failed");
        require(snapshot.stats.files == 800 && snapshot.stats.errors == 0, "worker fallback lost files");
    }
    fail_after = -1;
}
int main(int argc, char** argv) {
    require(argc == 2, "test case required");
    const std::string test = argv[1];
    if (test == "equivalence") equivalence();
    else if (test == "depth") depth();
    else if (test == "symlink" || test == "inode" || test == "opened") replacement(test);
    else if (test == "resources") resources();
    else require(false, "unknown test case");
}
