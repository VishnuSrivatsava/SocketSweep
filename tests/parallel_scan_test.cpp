#include <cerrno>
#include <cstdio>
#include <filesystem>
#include <functional>
#include <map>
#include <pthread.h>
#include <sys/resource.h>
#include <thread>

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
static Snapshot run(const std::string& path, int workers, bool streaming = false) {
    safe_delete::Root root;
    require(root.open(path), "root open failed");
    Snapshot snapshot;
    snapshot.tree.name = path.substr(path.rfind('/') + 1);
    snapshot.tree.path = path;
    snapshot.tree.is_dir = true;
    snapshot.tree.device = root.identity.st_dev;
    snapshot.tree.inode = root.identity.st_ino;
    if (streaming) {
        int sockets[2];
        require(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0, "socketpair failed");
        safe_delete::Fd writer(sockets[0]), reader(sockets[1]);
        std::thread drain([&] { char bytes[4096]; while (::recv(reader.get(), bytes, sizeof(bytes), 0) > 0) {} });
        ScanOutput output(writer.get());
        require(output.start(path), "stream start failed");
        uint64_t id = 0;
        require(output.entry(snapshot.tree, 0, "directory", true, id), "stream root failed");
        stream_scan::Pool pool(root, output, snapshot.tree);
        snapshot.result.workers = pool.run(snapshot.stats, workers);
        snapshot.result.queue_peak = pool.queue_peak();
        require(output.finish(snapshot.stats, 0, snapshot.result.workers), "stream finish failed");
        ::shutdown(writer.get(), SHUT_WR);
        drain.join();
    } else {
        snapshot.result = parallel_scan::run(root, snapshot.tree, snapshot.stats, workers, cfg::MAX_DEPTH);
    }
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
static void equivalence(bool streaming = false) {
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
        for (int repeat = 0; repeat < 3; ++repeat) {
            auto actual = run(fixture.path, workers, streaming);
            if (!streaming) same(actual, expected, stats);
            else require(actual.stats.files == stats.files && actual.stats.dirs == stats.dirs &&
                         actual.stats.total_size == stats.total_size && actual.stats.errors == stats.errors,
                         "stream statistics differ from serial reference");
        }
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
static void replacement(const std::string& kind, bool streaming = false) {
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
    const auto snapshot = run(fixture.path + "/root", 4, streaming);
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
static void resources(bool streaming = false) {
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
    const auto serial = run(fixture.path, 1, streaming);
    require(serial.result.queue_peak == parallel_scan::MAX_PENDING && serial.stats.files == 800,
            "queue saturation fallback lost work");
    for (int i = 0; i < 8; ++i) {
        const auto snapshot = run(fixture.path, 8, streaming);
        require(snapshot.stats.files == 800 && snapshot.stats.total_size == 5600 &&
                snapshot.stats.errors == 0, "low-descriptor scan failed");
    }
    require(descriptors() == before, "scan leaked descriptors");
    require(::setrlimit(RLIMIT_NOFILE, &saved) == 0, "restore rlimit failed");
    for (int failure : {0, 2}) {
        fail_after = failure;
        create_calls = 0;
        const auto snapshot = run(fixture.path, 8, streaming);
        require(snapshot.result.workers == failure + 1, "worker creation fallback failed");
        require(snapshot.stats.files == 800 && snapshot.stats.errors == 0, "worker fallback lost files");
    }
    fail_after = -1;
}
static std::string read_frame(int fd) {
    uint32_t size = 0;
    require(::recv(fd, &size, sizeof(size), MSG_WAITALL) == sizeof(size), "missing frame header");
    size = ntohl(size);
    require(size > 0 && size <= ScanOutput::MAX_FRAME_BYTES, "bad frame size");
    std::string text(size, ' ');
    require(::recv(fd, text.data(), size, MSG_WAITALL) == size, "missing frame body");
    return text;
}
static void stream_cancel() {
    Fixture fixture;
    fixture.dir("selected"); fixture.file("selected/later", 20); fixture.file("early", 7);
    g_read_only = false;
    require(g_scan_root.open(fixture.path), "previous root open failed");
    int sockets[2];
    require(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0, "socketpair failed");
    safe_delete::Fd writer(sockets[0]), reader(sockets[1]);
    std::mutex mutex;
    std::condition_variable ready;
    bool blocked = false, release = false;
    checkpoint = [&](const char* event, int, const char* name) {
        if (std::string(event) != "opened" || std::string(name) != fixture.path + "/selected") return;
        std::unique_lock<std::mutex> lock(mutex);
        blocked = true; ready.notify_one();
        ready.wait(lock, [&] { return release; });
    };
    std::thread server([&] { stream_scan::handle(writer.get(), fixture.path); });
    {
        std::unique_lock<std::mutex> lock(mutex);
        require(ready.wait_for(lock, std::chrono::seconds(5), [&] { return blocked; }), "traversal barrier not reached");
    }
    // Traversal is deterministically unfinished while these records arrive.
    require(read_frame(reader.get()).find("started") != std::string::npos, "missing start");
    // Worker callbacks are paused: the first entry is guaranteed to have been
    // flushed immediately, irrespective of directory enumeration order.
    require(read_frame(reader.get()).find("entries") != std::string::npos, "missing root record");
    const auto first = read_frame(reader.get());
    require(first.find("entries") != std::string::npos, "missing first result");
    const bool early = first.find("early") != std::string::npos || first.find("selected") != std::string::npos;
    require(early, "no result before completion");
    ::shutdown(reader.get(), SHUT_RDWR);
    {
        std::lock_guard<std::mutex> lock(mutex); release = true; ready.notify_one();
    }
    server.join(); checkpoint = {};
    require(g_scan_root.fd.get() < 0, "cancelled scan enabled deletion");
}
static void stream_limits_and_root_replacement(bool replace) {
    Fixture fixture;
    fixture.dir("root"); fixture.file("root/keep", 7);
    for (int i = 0; i < 30; ++i) fixture.dir("root/dir" + std::to_string(i));
    const auto path = fixture.path + "/root";
    g_read_only = false;
    int sockets[2];
    require(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0, "socketpair failed");
    safe_delete::Fd writer(sockets[0]), reader(sockets[1]);
    std::string wire;
    std::thread drain([&] { char bytes[4096]; ssize_t size; while ((size = ::recv(reader.get(), bytes, sizeof(bytes), 0)) > 0) wire.append(bytes, size); });
    if (replace) {
        bool fired = false;
        checkpoint = [&](const char* event, int, const char* name) {
            if (fired || std::string(event) != "opened" || std::string(name) != path) return;
            fired = true;
            require(::rename(path.c_str(), (fixture.path + "/moved").c_str()) == 0, "root rename failed");
            fixture.dir("root"); fixture.file("root/replacement", 1000000);
        };
        stream_scan::handle(writer.get(), path);
        checkpoint = {};
        require(fired && g_scan_root.fd.get() < 0, "changed root enabled deletion");
    } else {
        safe_delete::Root root;
        require(root.open(path), "root open failed");
        FileNode node; node.name = "root"; node.path = path; node.is_dir = true;
        node.device = root.identity.st_dev; node.inode = root.identity.st_ino;
        ScanOutput output(writer.get());
        require(output.start(path), "stream start failed");
        uint64_t id = 0; require(output.entry(node, 0, "directory", true, id), "root entry failed");
        stream_scan::Pool pool(root, output, node, 256);
        ScanStats stats; const int workers = pool.run(stats, 4);
        require(!output.finish(stats, 0, workers), "staging budget ignored");
    }
    ::shutdown(writer.get(), SHUT_WR); drain.join();
    require(wire.find("\"type\":\"error\"") != std::string::npos, "missing stream failure");
    require(wire.find("\"type\":\"done\"") == std::string::npos, "failed stream reported success");
}
int main(int argc, char** argv) {
    require(argc == 2, "test case required");
    const std::string test = argv[1];
    if (test == "equivalence") equivalence();
    else if (test == "depth") depth();
    else if (test == "symlink" || test == "inode" || test == "opened") replacement(test);
    else if (test == "resources") resources();
    else if (test == "stream_equivalence") equivalence(true);
    else if (test == "stream_resources") resources(true);
    else if (test == "stream_symlink" || test == "stream_inode" || test == "stream_opened") replacement(test.substr(7), true);
    else if (test == "stream_cancel") stream_cancel();
    else if (test == "stream_budget") stream_limits_and_root_replacement(false);
    else if (test == "stream_root") stream_limits_and_root_replacement(true);
    else require(false, "unknown test case");
}
