#pragma once

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <string>
#include <utility>
#include <vector>
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

// Deterministic race barriers exist only in the host regression-test build.
#ifndef SOCKETSWEEP_DELETE_CHECKPOINT
#define SOCKETSWEEP_DELETE_CHECKPOINT(event, parent, name) ((void)0)
#endif

namespace safe_delete {

class Fd {
    int value_ = -1;
public:
    explicit Fd(int value = -1) : value_(value) {}
    ~Fd() { reset(); }
    Fd(const Fd&) = delete;
    Fd& operator=(const Fd&) = delete;
    Fd(Fd&& other) noexcept : value_(other.release()) {}
    Fd& operator=(Fd&& other) noexcept {
        if (this != &other) reset(other.release());
        return *this;
    }
    int get() const { return value_; }
    int release() { int value = value_; value_ = -1; return value; }
    void reset(int value = -1) {
        if (value_ >= 0) ::close(value_);
        value_ = value;
    }
};

inline bool same_entry(const struct stat& a, const struct stat& b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino &&
           (a.st_mode & S_IFMT) == (b.st_mode & S_IFMT);
}

struct Root {
    Fd fd;
    std::string path;
    struct stat identity{};

    void clear() { fd.reset(); path.clear(); }

    bool open(const std::string& scan_path) {
        clear();
        // Follow the root alias once: /sdcard is normally a symlink. Children
        // are always opened one component at a time with O_NOFOLLOW.
        Fd opened(::open(scan_path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC));
        if (opened.get() < 0 || ::fstat(opened.get(), &identity) != 0) return false;
        fd = std::move(opened);
        path = scan_path;
        return true;
    }

    bool unchanged() const {
        struct stat current{};
        return fd.get() >= 0 && ::stat(path.c_str(), &current) == 0 &&
               same_entry(identity, current);
    }
};

struct Result {
    std::uintmax_t removed = 0;
    std::string error;
    bool fail(const char* message) { error = message; return false; }
    bool system_error() { return fail(std::strerror(errno)); }
};

struct Directory {
    Fd fd;
    std::string name;
    struct stat identity;
};

class Walk {
    const Root& root_;
    std::vector<Directory> parents_;
public:
    explicit Walk(const Root& root) : root_(root) {}
    int parent() const { return parents_.empty() ? root_.fd.get() : parents_.back().fd.get(); }

    bool unchanged(Result& result) const {
        if (!root_.unchanged()) return result.fail("Scan root changed; rescan before deleting");
        int parent_fd = root_.fd.get();
        for (const auto& directory : parents_) {
            struct stat named{};
            if (::fstatat(parent_fd, directory.name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0 ||
                !same_entry(directory.identity, named)) {
                return result.fail("Directory changed during deletion; rescan before deleting");
            }
            parent_fd = directory.fd.get();
        }
        return true;
    }

    bool descend(const std::string& name, const struct stat& expected, Result& result) {
        if (!unchanged(result)) return false;
        SOCKETSWEEP_DELETE_CHECKPOINT("before_open", parent(), name.c_str());
        Fd opened(::openat(parent(), name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
        if (opened.get() < 0) return result.system_error();
        struct stat actual{};
        if (::fstat(opened.get(), &actual) != 0) return result.system_error();
        if (!same_entry(expected, actual)) return result.fail("Directory replaced during deletion");
        if (actual.st_dev != root_.identity.st_dev) return result.fail("Deletion cannot cross a filesystem boundary");
        parents_.push_back({std::move(opened), name, actual});
        SOCKETSWEEP_DELETE_CHECKPOINT("opened", parent(), name.c_str());
        return unchanged(result);
    }

    Fd ascend() {
        Fd opened = std::move(parents_.back().fd);
        parents_.pop_back();
        return opened;
    }
};

inline bool remove_entry(Walk& walk, const std::string& name, int remaining,
                         bool allow_symlink, Result& result) {
    if (!walk.unchanged(result)) return false;
    struct stat expected{};
    if (::fstatat(walk.parent(), name.c_str(), &expected, AT_SYMLINK_NOFOLLOW) != 0) {
        return result.system_error();
    }
    if (S_ISLNK(expected.st_mode) && !allow_symlink) return result.fail("Delete target is a symlink");

    Fd pinned_directory;
    if (S_ISDIR(expected.st_mode)) {
        if (remaining <= 0) return result.fail("Deletion depth limit reached");
        if (!walk.descend(name, expected, result)) return false;
        // Use a separate descriptor for readdir. fdopendir owns its argument;
        // the walk keeps its own directory handle for all child operations.
        Fd listing_fd(::openat(walk.parent(), ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
        if (listing_fd.get() < 0) return result.system_error();
        DIR* listing = ::fdopendir(listing_fd.get());
        if (!listing) return result.system_error();
        listing_fd.release();
        bool ok = true;
        while (ok) {
            errno = 0;
            struct dirent* entry = ::readdir(listing);
            if (!entry) {
                if (errno != 0) ok = result.system_error();
                break;
            }
            const std::string child = entry->d_name;
            if (child == "." || child == "..") continue;
            // Symlinks inside a selected directory are unlinked, never opened.
            ok = remove_entry(walk, child, remaining - 1, true, result);
        }
        ::closedir(listing);
        if (!ok) return false;
        // Keep the directory inode alive through the final identity check and
        // unlink, so removing it cannot make its inode number reusable here.
        pinned_directory = walk.ascend();
    }

    SOCKETSWEEP_DELETE_CHECKPOINT("before_unlink", walk.parent(), name.c_str());
    if (!walk.unchanged(result)) return false;
    struct stat current{};
    if (::fstatat(walk.parent(), name.c_str(), &current, AT_SYMLINK_NOFOLLOW) != 0 ||
        !same_entry(expected, current)) return result.fail("Entry changed during deletion");
    // unlinkat never follows the final symlink, and every parent is an opened
    // directory. Replacing a pathname cannot redirect removal to its target.
    SOCKETSWEEP_DELETE_CHECKPOINT("unlink", walk.parent(), name.c_str());
    if (::unlinkat(walk.parent(), name.c_str(), S_ISDIR(expected.st_mode) ? AT_REMOVEDIR : 0) != 0) {
        return result.system_error();
    }
    ++result.removed;
    return true;
}

inline Result remove(const Root& root, const std::string& target, int max_depth = 64) {
    Result result;
    if (root.fd.get() < 0) {
        result.fail("No scan performed yet; cannot validate delete target");
        return result;
    }
    std::string prefix = root.path;
    if (prefix.back() != '/') prefix += '/';
    if (target.compare(0, prefix.size(), prefix) != 0 || target.size() <= prefix.size()) {
        result.fail("Delete target must be strictly inside the scan root");
        return result;
    }
    std::vector<std::string> components;
    size_t start = prefix.size();
    while (start <= target.size()) {
        size_t end = target.find('/', start);
        if (end == std::string::npos) end = target.size();
        std::string component = target.substr(start, end - start);
        if (component.empty() || component == "." || component == ".." ||
            component.find('\0') != std::string::npos ||
            components.size() >= static_cast<size_t>(max_depth)) {
            result.fail("Invalid delete path component");
            return result;
        }
        components.push_back(std::move(component));
        if (end == target.size()) break;
        start = end + 1;
    }
    Walk walk(root);
    for (size_t i = 0; i + 1 < components.size(); ++i) {
        struct stat expected{};
        if (::fstatat(walk.parent(), components[i].c_str(), &expected, AT_SYMLINK_NOFOLLOW) != 0) {
            result.system_error();
            return result;
        }
        if (!S_ISDIR(expected.st_mode)) {
            result.fail("Delete parent must be a directory, not a symlink");
            return result;
        }
        if (!walk.descend(components[i], expected, result)) return result;
    }
    remove_entry(walk, components.back(), max_depth, false, result);
    return result;
}

} // namespace safe_delete
