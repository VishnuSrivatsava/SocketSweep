#pragma once

// Authenticated single-file export read (protocol v4).
//
// READ <absolute-path-under-scan-root>
//   → {"status":"ok","size":N,"uid":U,"read_only":R}\n
//   → exactly N payload bytes, then immediate EOF.
//
// Confinement is structural, never a string check: components are opened one
// at a time from the pinned scan-root descriptor with O_NOFOLLOW, each opened
// inode is re-verified against its directory lookup, and crossing a
// filesystem boundary is refused. A swapped symlink or replacement file can
// never redirect the read outside the scanned tree.

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include "safe_delete.h"

namespace file_read {

inline bool send_all(int fd, const char* p, size_t left) {
    while (left > 0) {
        const ssize_t n = ::send(fd, p, left, MSG_NOSIGNAL);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return false;
        p += n;
        left -= static_cast<size_t>(n);
    }
    return true;
}

inline void send_error(int fd, const char* code, const char* message) {
    // Both fields are fixed ASCII constants; no path or name is ever echoed.
    std::string reply = "{\"status\":\"error\",\"code\":\"";
    reply += code;
    reply += "\",\"message\":\"";
    reply += message;
    reply += "\"}\n";
    send_all(fd, reply.data(), reply.size());
}

inline bool relative_components(const std::string& root_path, const std::string& target,
                                int max_depth, std::vector<std::string>& out) {
    if (target == root_path) return true;  // zero components: the scan root itself
    std::string prefix = root_path;
    if (prefix.back() != '/') prefix += '/';
    if (target.compare(0, prefix.size(), prefix) != 0 || target.size() <= prefix.size()) return false;
    size_t start = prefix.size();
    while (start <= target.size()) {
        const size_t end = target.find('/', start);
        const size_t stop = end == std::string::npos ? target.size() : end;
        std::string component = target.substr(start, stop - start);
        if (component.empty() || component == "." || component == ".." ||
            component.find('\0') != std::string::npos ||
            out.size() >= static_cast<size_t>(max_depth)) return false;
        out.push_back(std::move(component));
        if (stop == target.size()) break;
        start = stop + 1;
    }
    return true;
}

// Streams one regular file beneath the pinned scan root. Every failure before
// the header is reported as a structured JSON error; after the header the
// byte count is a promise — any shortfall simply ends the stream and the
// receiving side treats the transfer as failed.
inline void handle(int fd, const std::string& target) {
    if (g_scan_root.fd.get() < 0) {
        send_error(fd, "no_scan_root", "No completed scan to export from");
        return;
    }
    if (!g_scan_root.unchanged()) {
        send_error(fd, "scan_root_changed", "Scan root changed; rescan before exporting");
        return;
    }
    std::vector<std::string> components;
    if (!relative_components(g_scan_root.path, target, cfg::MAX_DEPTH, components)) {
        send_error(fd, "invalid_path",
                   "Export target must be a regular file strictly inside the scan root");
        return;
    }
    if (components.empty()) {
        // The scan root is a directory by definition, never the scanned file.
        send_error(fd, "source_unavailable", "Source path is no longer the scanned regular file");
        return;
    }

    safe_delete::Result result;
    safe_delete::Walk walk(g_scan_root);
    for (size_t i = 0; i + 1 < components.size(); ++i) {
        struct stat expected{};
        if (::fstatat(walk.parent(), components[i].c_str(), &expected, AT_SYMLINK_NOFOLLOW) != 0 ||
            !S_ISDIR(expected.st_mode)) {
            send_error(fd, "source_unavailable", "Source path is no longer the scanned file");
            return;
        }
        if (!walk.descend(components[i], expected, result)) {
            send_error(fd, "source_unavailable", "Source path is no longer the scanned file");
            return;
        }
    }

    struct stat expected{};
    if (::fstatat(walk.parent(), components.back().c_str(), &expected, AT_SYMLINK_NOFOLLOW) != 0) {
        send_error(fd, "source_unavailable", "Source path is no longer the scanned file");
        return;
    }
    if (S_ISLNK(expected.st_mode) || !S_ISREG(expected.st_mode)) {
        send_error(fd, "source_unavailable", "Source path is no longer the scanned regular file");
        return;
    }
    safe_delete::Fd opened(
        ::openat(walk.parent(), components.back().c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
    if (opened.get() < 0) {
        send_error(fd, "source_unavailable", "Source path is no longer the scanned file");
        return;
    }
    struct stat actual{};
    if (::fstat(opened.get(), &actual) != 0 || !safe_delete::same_entry(expected, actual) ||
        !S_ISREG(actual.st_mode) || actual.st_size < 0) {
        send_error(fd, "source_unavailable", "Source path is no longer the scanned regular file");
        return;
    }

    const auto total = static_cast<std::uint64_t>(actual.st_size);
    std::string header = "{\"status\":\"ok\",\"size\":";
    header += std::to_string(total);
    header += ",\"uid\":";
    header += std::to_string(::geteuid());
    header += ",\"read_only\":";
    header += g_read_only ? "true" : "false";
    header += "}\n";
    if (!send_all(fd, header.data(), header.size())) return;

    // The descriptor pins the inode; a concurrent shrink surfaces as a short
    // read and the promised byte count is never completed. Growth past the
    // announced size is ignored: the header size is what was verified.
    std::uint64_t remaining = total;
    char buffer[256 * 1024];
    while (remaining > 0) {
        size_t chunk = sizeof(buffer);
        if (static_cast<std::uint64_t>(chunk) > remaining) chunk = static_cast<size_t>(remaining);
        const ssize_t n = ::read(opened.get(), buffer, chunk);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return;
        if (!send_all(fd, buffer, static_cast<size_t>(n))) return;
        remaining -= static_cast<std::uint64_t>(n);
    }
}

} // namespace file_read
