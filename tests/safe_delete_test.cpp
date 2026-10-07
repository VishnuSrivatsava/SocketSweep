// Host-only race tests. Checkpoints force replacements at specific system-call
// boundaries; the Android daemon compiles without these hooks.
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <sys/resource.h>

static std::function<void(const char*, int, const char*)> checkpoint;
static void run_checkpoint(const char* event, int parent, const char* name) {
    if (checkpoint) checkpoint(event, parent, name);
}
#define SOCKETSWEEP_DELETE_CHECKPOINT(event, parent, name) run_checkpoint(event, parent, name)
#include "../engine/safe_delete.h"

namespace fs = std::filesystem;

static void require(bool condition, const char* message) {
    if (!condition) { std::fprintf(stderr, "%s\n", message); std::exit(1); }
}

struct Fixture {
    fs::path base, storage, outside;
    safe_delete::Root root;
    Fixture() {
        char name[] = "/tmp/socketsweep-delete-test-XXXXXX";
        char* created = ::mkdtemp(name);
        require(created != nullptr, "Cannot create temporary fixture");
        char* canonical = ::realpath(created, nullptr);
        require(canonical != nullptr, "Cannot resolve temporary fixture");
        base = canonical;
        std::free(canonical);
        storage = base / "storage";
        outside = base / "outside";
        fs::create_directories(storage / "parent");
        fs::create_directories(outside / "parent");
        std::ofstream(storage / "parent" / "keep") << "original";
        std::ofstream(outside / "parent" / "keep") << "outside must survive";
        require(root.open(storage.string()), "Cannot pin fixture root");
    }
    ~Fixture() {
        checkpoint = {};
        root.clear();
        fs::remove_all(base);
    }
    void protected_file_survived() {
        std::ifstream input(outside / "parent" / "keep");
        std::string contents;
        std::getline(input, contents);
        require(contents == "outside must survive", "Outside file was changed or deleted");
    }
};

static void parent_symlink_before_open() {
    Fixture f;
    bool fired = false;
    checkpoint = [&](const char* event, int, const char* name) {
        if (!fired && std::string(event) == "before_open" && std::string(name) == "parent") {
            fired = true;
            fs::rename(f.storage / "parent", f.storage / "saved");
            fs::create_directory_symlink(f.outside / "parent", f.storage / "parent");
        }
    };
    const auto result = safe_delete::remove(f.root, (f.storage / "parent" / "keep").string());
    require(fired && !result.error.empty(), "Parent substitution must be rejected");
    require(fs::exists(f.storage / "saved" / "keep"), "Original file must survive rejected deletion");
    f.protected_file_survived();
}

static void parent_replaced_after_open() {
    Fixture f;
    bool fired = false;
    checkpoint = [&](const char* event, int, const char* name) {
        if (!fired && std::string(event) == "opened" && std::string(name) == "parent") {
            fired = true;
            fs::rename(f.storage / "parent", f.base / "moved");
            fs::create_directory_symlink(f.outside / "parent", f.storage / "parent");
        }
    };
    const auto result = safe_delete::remove(f.root, (f.storage / "parent" / "keep").string());
    require(fired && !result.error.empty(), "Detached parent must be rejected");
    require(fs::exists(f.base / "moved" / "keep"), "Moved original file must survive");
    f.protected_file_survived();
}

static void directory_replaced_with_real_directory() {
    Fixture f;
    bool fired = false;
    checkpoint = [&](const char* event, int, const char* name) {
        if (!fired && std::string(event) == "before_open" && std::string(name) == "parent") {
            fired = true;
            fs::rename(f.storage / "parent", f.storage / "saved");
            fs::rename(f.outside / "parent", f.storage / "parent");
        }
    };
    const auto result = safe_delete::remove(f.root, (f.storage / "parent").string());
    require(fired && !result.error.empty(), "A different directory inode must be rejected");
    require(fs::exists(f.storage / "parent" / "keep"), "Replacement contents must survive");
    require(fs::exists(f.storage / "saved" / "keep"), "Original contents must survive");
}

static void recursive_child_symlink_swap() {
    Fixture f;
    fs::create_directories(f.storage / "parent" / "child");
    std::ofstream(f.storage / "parent" / "child" / "keep") << "original";
    bool fired = false;
    checkpoint = [&](const char* event, int, const char* name) {
        if (!fired && std::string(event) == "before_open" && std::string(name) == "child") {
            fired = true;
            fs::rename(f.storage / "parent" / "child", f.storage / "saved-child");
            fs::create_directory_symlink(f.outside / "parent", f.storage / "parent" / "child");
        }
    };
    const auto result = safe_delete::remove(f.root, (f.storage / "parent").string());
    require(fired && !result.error.empty(), "Recursive symlink substitution must be rejected");
    require(fs::exists(f.storage / "saved-child" / "keep"), "Detached child must survive");
    f.protected_file_survived();
}

static void leaf_swap_before_identity_check() {
    Fixture f;
    bool fired = false;
    checkpoint = [&](const char* event, int, const char* name) {
        if (!fired && std::string(event) == "before_unlink" && std::string(name) == "keep") {
            fired = true;
            fs::rename(f.storage / "parent" / "keep", f.storage / "parent" / "saved");
            fs::create_symlink(f.outside / "parent" / "keep", f.storage / "parent" / "keep");
        }
    };
    const auto result = safe_delete::remove(f.root, (f.storage / "parent" / "keep").string());
    require(fired && !result.error.empty(), "Changed leaf must be rejected");
    require(fs::exists(f.storage / "parent" / "saved"), "Original leaf must survive");
    f.protected_file_survived();
}

static void leaf_swap_at_unlink_does_not_follow_symlink() {
    Fixture f;
    bool fired = false;
    checkpoint = [&](const char* event, int, const char* name) {
        if (!fired && std::string(event) == "unlink" && std::string(name) == "keep") {
            fired = true;
            fs::rename(f.storage / "parent" / "keep", f.storage / "parent" / "saved");
            fs::create_symlink(f.outside / "parent" / "keep", f.storage / "parent" / "keep");
        }
    };
    const auto result = safe_delete::remove(f.root, (f.storage / "parent" / "keep").string());
    require(fired && result.error.empty() && result.removed == 1, "unlinkat must remove only the link entry");
    require(fs::exists(f.storage / "parent" / "saved"), "Original leaf must survive");
    f.protected_file_survived();
}

static void root_alias_swap_at_unlink_keeps_original_anchor() {
    Fixture f;
    const auto alias = f.base / "alias";
    fs::create_directory_symlink(f.storage, alias);
    require(f.root.open(alias.string()), "Root aliases must be supported");
    bool fired = false;
    checkpoint = [&](const char* event, int, const char* name) {
        if (!fired && std::string(event) == "unlink" && std::string(name) == "keep") {
            fired = true;
            fs::remove(alias);
            fs::create_directory_symlink(f.outside, alias);
        }
    };
    const auto result = safe_delete::remove(f.root, (alias / "parent" / "keep").string());
    require(fired && result.error.empty(), "Removal must use the original root descriptor");
    require(!fs::exists(f.storage / "parent" / "keep"), "Original selected file should be removed");
    f.protected_file_survived();
    require(!safe_delete::remove(f.root, (alias / "parent" / "keep").string()).error.empty(),
            "Further deletion through the changed alias must be rejected");
}

static void repeated_calls_release_descriptors() {
    Fixture f;
    struct rlimit limit{};
    require(::getrlimit(RLIMIT_NOFILE, &limit) == 0, "Cannot read descriptor limit");
    if (limit.rlim_cur > 64) limit.rlim_cur = 64;
    require(::setrlimit(RLIMIT_NOFILE, &limit) == 0, "Cannot constrain descriptor limit");
    for (int i = 0; i < 200; ++i) {
        const auto directory = f.storage / "iteration";
        fs::create_directories(directory / "child");
        std::ofstream(directory / "child" / "file") << "test";
        const auto result = safe_delete::remove(f.root, directory.string());
        require(result.error.empty() && result.removed == 3, "Repeated recursive removal failed");
        const auto bad = safe_delete::remove(f.root, (f.storage / "parent" / "missing" / "file").string());
        require(!bad.error.empty(), "Missing parents must fail safely");
    }
    f.protected_file_survived();
}

static void depth_limit_fails_without_following_links() {
    Fixture f;
    fs::create_directories(f.storage / "deep" / "one" / "two");
    std::ofstream(f.storage / "deep" / "one" / "two" / "keep") << "keep";
    const auto result = safe_delete::remove(f.root, (f.storage / "deep").string(), 2);
    require(!result.error.empty(), "Deep recursion must stop at the configured limit");
    require(fs::exists(f.storage / "deep" / "one" / "two" / "keep"), "Deep contents must survive");
    f.protected_file_survived();
}

int main(int argc, char** argv) {
    require(argc == 2, "Expected one test case name");
    const std::string test = argv[1];
    if (test == "parent_symlink") parent_symlink_before_open();
    else if (test == "parent_replaced") parent_replaced_after_open();
    else if (test == "directory_inode") directory_replaced_with_real_directory();
    else if (test == "recursive_child") recursive_child_symlink_swap();
    else if (test == "leaf_replaced") leaf_swap_before_identity_check();
    else if (test == "leaf_unlink") leaf_swap_at_unlink_does_not_follow_symlink();
    else if (test == "root_alias") root_alias_swap_at_unlink_keeps_original_anchor();
    else if (test == "descriptors") repeated_calls_release_descriptors();
    else if (test == "depth") depth_limit_fails_without_following_links();
    else require(false, "Unknown test case");
    return 0;
}
