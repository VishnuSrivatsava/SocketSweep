// ============================================================================
// daemon.cpp — Anti-MTP Android Storage Analyzer Engine
// ============================================================================

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cerrno>
#include <string>
#include <vector>

#include <arpa/inet.h>
#include <dirent.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include "safe_delete.h"
#include <iostream>
#include <fstream>
#include <poll.h>

// ── Configuration ───────────────────────────────────────────────────────────
namespace cfg {
    constexpr uint16_t    PORT              = 5050;
    constexpr const char* BIND_ADDR         = "127.0.0.1";
    constexpr const char* DEFAULT_ROOT      = "/sdcard";
    constexpr int         LISTEN_BACKLOG    = 4;
    constexpr int         MAX_DEPTH         = 64;
    constexpr int         RECV_TIMEOUT_SEC  = 30;
    constexpr size_t      MAX_COMMAND_BYTES = 16 * 1024;
}

// ── Globals ─────────────────────────────────────────────────────────────────
static volatile sig_atomic_t g_running = 1;
static void on_signal(int) { g_running = 0; }
static safe_delete::Root g_scan_root; // pins the successful scan root for deletion
static std::string g_session_token;

// Per-phase scan timing (see SCAN in handle_client). Counters reset per scan.
static int64_t g_sort_ns    = 0;  // cumulative time sorting directory children
static int64_t g_send_ns    = 0;  // cumulative time blocked in ::send (socket writes)
static int64_t g_send_bytes = 0;  // cumulative bytes handed to ::send

static inline int64_t ns_to_ms(int64_t ns) { return ns / 1000000; }

// ── Network & Streaming Helpers ─────────────────────────────────────────────
class JsonStream {
    int fd;
    std::string buf;
public:
    JsonStream(int fd) : fd(fd) {
        buf.reserve(64 * 1024);
    }
    ~JsonStream() { flush(); }
    
    bool write(const char* data, size_t len) {
        if (buf.size() + len > buf.capacity()) {
            if (!flush()) return false;
        }
        if (len >= buf.capacity()) {
            return send_all(fd, data, len);
        } else {
            buf.append(data, len);
            return true;
        }
    }
    
    bool write(const std::string& s) { return write(s.data(), s.size()); }
    
    bool flush() {
        if (!buf.empty()) {
            bool ok = send_all(fd, buf.data(), buf.size());
            buf.clear();
            return ok;
        }
        return true;
    }

    static bool send_all(int fd, const char* p, size_t left) {
        const size_t total = left;
        const auto t0 = std::chrono::steady_clock::now();
        while (left > 0) {
            ssize_t n = ::send(fd, p, left, MSG_NOSIGNAL);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) break;
            p    += n;
            left -= static_cast<size_t>(n);
        }
        g_send_ns    += std::chrono::duration_cast<std::chrono::nanoseconds>(
                            std::chrono::steady_clock::now() - t0).count();
        g_send_bytes += total - left;
        return left == 0;
    }
};

static bool recv_line(int fd, std::string& line) {
    line.clear();
    const auto deadline = std::chrono::steady_clock::now() +
        std::chrono::seconds(cfg::RECV_TIMEOUT_SEC);
    char c;
    while (true) {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now()).count();
        if (remaining <= 0) return false;
        struct pollfd event { fd, POLLIN, 0 };
        int ready = ::poll(&event, 1, static_cast<int>(remaining));
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) return false;
        ssize_t n = ::recv(fd, &c, 1, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return false;
        if (c == '\n') return true;
        // Never normalize path bytes or execute an incomplete/oversized line.
        if (c == '\r' || c == '\0' || line.size() >= cfg::MAX_COMMAND_BYTES) return false;
        line += c;
    }
}

static bool valid_token(const std::string& token) {
    return token.size() == 64 && std::all_of(token.begin(), token.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}

// ── Data Model ──────────────────────────────────────────────────────────────
struct FileNode {
    std::string              name;
    std::string              path;
    bool                     is_dir = false;
    int64_t                  size   = 0;
    std::vector<FileNode>    children;
};

struct ScanStats {
    int64_t files      = 0;
    int64_t dirs       = 0;
    int64_t total_size = 0;
    int64_t errors     = 0;
};

// ── JSON helpers ────────────────────────────────────────────────────────────
static void json_escape_into(JsonStream& out, const std::string& s) {
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out.write("\\\"", 2); break;
            case '\\': out.write("\\\\", 2); break;
            case '\b': out.write("\\b", 2); break;
            case '\f': out.write("\\f", 2); break;
            case '\n': out.write("\\n", 2); break;
            case '\r': out.write("\\r", 2); break;
            case '\t': out.write("\\t", 2); break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    int len = std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out.write(buf, len);
                } else {
                    char b = static_cast<char>(c);
                    out.write(&b, 1);
                }
        }
    }
}

static void serialize_node(JsonStream& out, const FileNode& node) {
    out.write("{\"name\":\"");
    json_escape_into(out, node.name);
    out.write("\",\"path\":\"");
    json_escape_into(out, node.path);
    out.write("\",\"type\":");
    out.write(node.is_dir ? "\"directory\"" : "\"file\"");
    out.write(",\"size\":");
    out.write(std::to_string(node.size));

    if (node.is_dir) {
        out.write(",\"children\":[");
        for (size_t i = 0; i < node.children.size(); ++i) {
            if (i > 0) out.write(",");
            serialize_node(out, node.children[i]);
        }
        out.write("]");
    }
    out.write("}");
}

// ── Recursive Scanner ───────────────────────────────────────────────────────
static FileNode scan(const std::string& path, const std::string& name,
                     ScanStats& st, int depth)
{
    FileNode node;
    node.name = name;
    node.path = path;

    struct stat info{};
    int stat_res = (depth == 0) ? ::stat(path.c_str(), &info) : ::lstat(path.c_str(), &info);
    if (stat_res != 0) {
        ++st.errors;
        return node;
    }

    if (depth > 0 && S_ISLNK(info.st_mode)) return node;

    if (S_ISREG(info.st_mode)) {
        node.size = info.st_size;
        ++st.files;
        st.total_size += info.st_size;
        return node;
    }

    if (!S_ISDIR(info.st_mode)) return node;

    node.is_dir = true;
    ++st.dirs;

    if (depth >= cfg::MAX_DEPTH) { ++st.errors; return node; }

    DIR* dir = ::opendir(path.c_str());
    if (!dir) { ++st.errors; return node; }

    struct dirent* ent;
    while ((ent = ::readdir(dir)) != nullptr) {
        if (ent->d_name[0] == '.') {
            if (ent->d_name[1] == '\0') continue;
            if (ent->d_name[1] == '.' && ent->d_name[2] == '\0') continue;
        }

        #ifdef DT_LNK
        if (ent->d_type == DT_LNK) continue;
        #endif

        std::string child_path = path + '/' + ent->d_name;

        FileNode child = scan(child_path, ent->d_name, st, depth + 1);
        node.size += child.size;
        node.children.push_back(std::move(child));
    }
    ::closedir(dir);

    const auto sort_t0 = std::chrono::steady_clock::now();
    std::sort(node.children.begin(), node.children.end(),
              [](const FileNode& a, const FileNode& b) {
                  return a.size > b.size;
              });
    g_sort_ns += std::chrono::duration_cast<std::chrono::nanoseconds>(
                     std::chrono::steady_clock::now() - sort_t0).count();

    return node;
}

// ── Command dispatch ────────────────────────────────────────────────────────
static void handle_client(int fd) {
    struct timeval tv { cfg::RECV_TIMEOUT_SEC, 0 };
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    JsonStream out(fd);
    std::string auth;
    if (!recv_line(fd, auth) || auth != "AUTH " + g_session_token) {
        out.write("{\"status\":\"error\",\"message\":\"Authentication failed\"}\n");
        return;
    }
    std::string cmd;
    if (!recv_line(fd, cmd) || cmd.empty()) {
        out.write("{\"status\":\"error\",\"message\":\"Invalid command framing\"}\n");
        return;
    }

    if (cmd == "PING") {
        out.write("{\"status\":\"ok\",\"message\":\"pong\",\"protocol_version\":2}\n");
    }
    else if (cmd == "SHUTDOWN") {
        out.write("{\"status\":\"ok\",\"message\":\"shutting down\"}\n");
        out.flush();
        g_running = 0;
        return;
    }
    else if (cmd.rfind("DELETE ", 0) == 0) {
        std::string target = cmd.substr(7);

        const auto result = safe_delete::remove(g_scan_root, target, cfg::MAX_DEPTH);
        if (!result.error.empty()) {
            out.write("{\"status\":\"error\",\"message\":\"");
            json_escape_into(out, result.error);
            if (result.removed > 0) {
                out.write("; some items were removed. Rescan before trying again");
            }
            out.write("\"}\n");
        } else {
            out.write("{\"status\":\"ok\",\"message\":\"Deleted ");
            out.write(std::to_string(result.removed));
            out.write(" items\"}\n");
        }
    }
    else if (cmd == "SCAN" || cmd.rfind("SCAN ", 0) == 0) {
        std::string root = cfg::DEFAULT_ROOT;
        if (cmd.size() > 4) {
            std::string arg = cmd.substr(5);
            if (!arg.empty()) root = arg;
        }
        while (root.size() > 1 && root.back() == '/') root.pop_back();

        std::string root_name = root;
        auto pos = root.rfind('/');
        if (pos != std::string::npos && pos + 1 < root.size())
            root_name = root.substr(pos + 1);

        std::fprintf(stderr, "[engine] SCAN \"%s\" ...\n", root.c_str());
        g_scan_root.clear();

        if (!g_scan_root.open(root)) {
            out.write("{\"status\":\"error\",\"message\":\"Scan root is not an accessible directory\"}\n");
            return;
        }

        g_sort_ns    = 0;
        g_send_ns    = 0;
        g_send_bytes = 0;

        auto t0 = std::chrono::steady_clock::now();
        ScanStats stats{};
        FileNode tree = scan(root, root_name, stats, 0);
        if (!g_scan_root.unchanged()) {
            g_scan_root.clear();
            out.write("{\"status\":\"error\",\"message\":\"Scan root changed during scan; scan again\"}\n");
            return;
        }
        auto t1 = std::chrono::steady_clock::now();
        int64_t ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
        int64_t traverse_ms = ms - ns_to_ms(g_sort_ns);
        if (traverse_ms < 0) traverse_ms = 0;

        std::fprintf(stderr, "[engine] Done: %lld files, %lld dirs, "
                     "%lld bytes, %lld errors, %lld ms "
                     "(traverse %lld ms, sort %lld ms)\n",
                     (long long)stats.files, (long long)stats.dirs,
                     (long long)stats.total_size, (long long)stats.errors,
                     (long long)ms, (long long)traverse_ms,
                     (long long)ns_to_ms(g_sort_ns));

        out.write("{\"status\":\"ok\",\"scan_time_ms\":");
        out.write(std::to_string(ms));
        out.write(",\"total_files\":");
        out.write(std::to_string(stats.files));
        out.write(",\"total_dirs\":");
        out.write(std::to_string(stats.dirs));
        out.write(",\"total_size\":");
        out.write(std::to_string(stats.total_size));
        out.write(",\"errors\":");
        out.write(std::to_string(stats.errors));
        out.write(",\"tree\":");
        serialize_node(out, tree);

        // Phase metrics are appended after the tree because serialization and
        // socket sends stream interleaved with it — the numbers are only final
        // once the tree has been written. Flush before snapshotting so the
        // byte/send counters cover the whole tree; only the trailing metrics
        // fields themselves (~100 bytes) go out uncounted via the destructor.
        out.flush();
        const auto t2 = std::chrono::steady_clock::now();
        const int64_t serialize_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t2 - t1).count();
        const int64_t send_ms      = ns_to_ms(g_send_ns);

        out.write(",\"traverse_ms\":");
        out.write(std::to_string(traverse_ms));
        out.write(",\"sort_ms\":");
        out.write(std::to_string(ns_to_ms(g_sort_ns)));
        out.write(",\"serialize_ms\":");
        out.write(std::to_string(serialize_ms));
        out.write(",\"send_ms\":");
        out.write(std::to_string(send_ms));
        out.write(",\"bytes_sent\":");
        out.write(std::to_string(g_send_bytes));
        out.write("}\n");
    }
    else {
        out.write("{\"status\":\"error\",\"message\":\"Unknown command\"}\n");
    }
    out.flush();
}

// ── Main ────────────────────────────────────────────────────────────────────
int main(int argc, char* argv[]) {
    std::ios_base::sync_with_stdio(false);

    uint16_t port = cfg::PORT;
    if (argc > 1) port = static_cast<uint16_t>(std::atoi(argv[1]));

    // A shell-owned 0600 file supplies the secret, keeping it out of process
    // arguments. Consume and unlink it before accepting any connections.
    if (argc != 3) {
        std::fprintf(stderr, "[engine] Usage: daemon PORT TOKEN_FILE\n");
        return 1;
    }
    {
        std::ifstream token_file(argv[2]);
        std::getline(token_file, g_session_token);
    }
    if (::unlink(argv[2]) != 0 || !valid_token(g_session_token)) {
        std::fprintf(stderr, "[engine] Failed to load session token\n");
        return 1;
    }

    ::signal(SIGINT,  on_signal);
    ::signal(SIGTERM, on_signal);
    ::signal(SIGPIPE, SIG_IGN);

    int srv = ::socket(AF_INET, SOCK_STREAM, 0);
    if (srv < 0) { std::perror("[engine] socket"); return 1; }

    int yes = 1;
    ::setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(port);
    ::inet_pton(AF_INET, cfg::BIND_ADDR, &addr.sin_addr);

    if (::bind(srv, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::perror("[engine] bind");
        ::close(srv);
        return 1;
    }
    if (::listen(srv, cfg::LISTEN_BACKLOG) < 0) {
        std::perror("[engine] listen");
        ::close(srv);
        return 1;
    }

    std::fprintf(stderr, "[engine] Listening on %s:%u  (pid %d)\n",
                 cfg::BIND_ADDR, port, static_cast<int>(::getpid()));

    while (g_running) {
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(srv, &fds);
        struct timeval tv { 1, 0 };
        int sel = ::select(srv + 1, &fds, nullptr, nullptr, &tv);
        if (sel <= 0) continue;

        struct sockaddr_in peer{};
        socklen_t peer_len = sizeof(peer);
        int client = ::accept(srv, reinterpret_cast<sockaddr*>(&peer), &peer_len);
        if (client < 0) continue;

        std::fprintf(stderr, "[engine] Client connected\n");
        handle_client(client);
        ::close(client);
        std::fprintf(stderr, "[engine] Client disconnected\n");
    }

    ::close(srv);
    std::fprintf(stderr, "[engine] Shutdown complete.\n");
    return 0;
}
