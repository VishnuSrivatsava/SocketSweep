#pragma once

// Stream v1 is bounded, length-prefixed JSON, independent of the legacy SCAN
// response. Entries precede their children; directory totals are computed by
// the host. No lossy filename conversion is performed by either endpoint.
class ScanOutput {
    struct Buffer {
        std::string text;
        bool write(const std::string& s) { text += s; return true; }
        bool write(const char* s, size_t n) { text.append(s, n); return true; }
    };
    int fd_;
    std::mutex mutex_;
    std::atomic<bool> failed_{false};
    uint64_t next_id_ = 0;
    size_t entries_ = 0;
    std::string batch_;
    std::chrono::steady_clock::time_point flushed_ = std::chrono::steady_clock::now();
    int64_t encode_ns_ = 0;

    bool peer_alive() {
        char byte;
        const ssize_t n = ::recv(fd_, &byte, 1, MSG_PEEK | MSG_DONTWAIT);
        // Half-close and extra commands both abort this one-command stream.
        return n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR);
    }
    bool send_bytes(const char* data, size_t length) {
        const auto start = std::chrono::steady_clock::now();
        const auto deadline = start + std::chrono::seconds(cfg::RECV_TIMEOUT_SEC);
        size_t left = length;
        while (left && g_running && !failed_) {
            const auto now = std::chrono::steady_clock::now();
            if (now >= deadline) break;
            const ssize_t n = ::send(fd_, data, left, MSG_NOSIGNAL | MSG_DONTWAIT);
            if (n > 0) { data += n; left -= static_cast<size_t>(n); continue; }
            if (n < 0 && errno == EINTR) continue;
            if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                struct pollfd event { fd_, POLLOUT, 0 };
                const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
                if (::poll(&event, 1, static_cast<int>(std::min<int64_t>(remaining, 100))) >= 0) continue;
                if (errno == EINTR) continue;
            }
            break;
        }
        g_send_bytes += length - left;
        g_send_ns += std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - start).count();
        if (left) failed_ = true;
        return left == 0;
    }
    bool frame(const std::string& text) {
        // Put the discriminator before the data. Serde can then deserialize
        // the selected frame directly instead of buffering a generic JSON tree.
        const auto comma = text.find(',');
        if (comma == std::string::npos) { failed_ = true; return false; }
        const std::string payload = text.substr(0, comma) + ",\"data\":{" + text.substr(comma + 1) + "}";
        if (payload.size() > MAX_FRAME_BYTES || !peer_alive()) {
            failed_ = true;
            return false;
        }
        const uint32_t length = htonl(static_cast<uint32_t>(payload.size()));
        std::string wire;
        wire.reserve(sizeof(length) + payload.size());
        wire.append(reinterpret_cast<const char*>(&length), sizeof(length));
        wire += payload;
        return send_bytes(wire.data(), wire.size());
    }
    bool flush_locked() {
        if (entries_ == 0) return !failed_;
        batch_ += "]}";
        const bool ok = frame(batch_);
        batch_.clear();
        entries_ = 0;
        flushed_ = std::chrono::steady_clock::now();
        return ok;
    }
public:
    static constexpr size_t MAX_FRAME_BYTES = 128 * 1024;
    static constexpr size_t MAX_BATCH_ENTRIES = 128;
    explicit ScanOutput(int fd) : fd_(fd) { batch_.reserve(64 * 1024); }
    bool alive() {
        if (failed_ || !g_running) return false;
        std::lock_guard<std::mutex> lock(mutex_);
        if (std::chrono::steady_clock::now() - flushed_ >= std::chrono::milliseconds(50)) {
            if (!peer_alive()) failed_ = true;
            if (!failed_) flush_locked();
            flushed_ = std::chrono::steady_clock::now();
        }
        return !failed_;
    }
    bool start(const std::string& root) {
        Buffer out;
        out.write("{\"type\":\"started\",\"stream_version\":1,\"root\":\"");
        json_escape_into(out, root);
        out.write("\",\"read_only\":");
        out.write(g_read_only ? "true}" : "false}");
        return frame(out.text);
    }
    bool entry(const FileNode& node, uint64_t parent, const char* kind, bool counted, uint64_t& id) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (failed_ || !g_running) return false;
        const auto start = std::chrono::steady_clock::now();
        id = next_id_++;
        Buffer out;
        out.write("{\"id\":" + std::to_string(id) + ",\"parent\":");
        out.write(id == 0 ? "null" : std::to_string(parent));
        out.write(",\"name\":\"");
        json_escape_into(out, node.name);
        out.write("\",\"kind\":\"" + std::string(kind) + "\",\"size\":" + std::to_string(node.size));
        out.write(counted ? ",\"counted\":true}" : ",\"counted\":false}");
        encode_ns_ += std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - start).count();
        if (out.text.size() + 48 > MAX_FRAME_BYTES) { failed_ = true; return false; }
        if (entries_ && (batch_.size() + out.text.size() + 16 > MAX_FRAME_BYTES || entries_ == MAX_BATCH_ENTRIES)) {
            if (!flush_locked()) return false;
        }
        if (entries_ == 0) batch_ = "{\"type\":\"entries\",\"entries\":[";
        else batch_ += ',';
        batch_ += out.text;
        ++entries_;
        // Publish the root and the first discovered entry promptly, then batch
        // subsequent records by size/count/time instead of a syscall per file.
        if (id <= 1 || entries_ == MAX_BATCH_ENTRIES ||
            std::chrono::steady_clock::now() - flushed_ >= std::chrono::milliseconds(50)) return flush_locked();
        return true;
    }
    bool error(const std::string& message) {
        std::lock_guard<std::mutex> lock(mutex_);
        batch_.clear(); entries_ = 0;
        Buffer out;
        out.write("{\"type\":\"error\",\"message\":\"");
        json_escape_into(out, message);
        out.write("\"}");
        const bool sent = frame(out.text);
        failed_ = true;
        return sent;
    }
    bool finish(const ScanStats& stats, int64_t elapsed_ms, int workers) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (failed_ || !flush_locked()) return false;
        const std::string text = "{\"type\":\"done\",\"total_files\":" + std::to_string(stats.files) +
            ",\"total_dirs\":" + std::to_string(stats.dirs) + ",\"total_size\":" + std::to_string(stats.total_size) +
            ",\"errors\":" + std::to_string(stats.errors) + ",\"skipped\":" + std::to_string(stats.skipped) +
            ",\"scan_time_ms\":" + std::to_string(elapsed_ms) + ",\"scan_threads\":" + std::to_string(workers) +
            ",\"serialize_ms\":" + std::to_string(ns_to_ms(encode_ns_)) +
            ",\"send_ms\":" + std::to_string(ns_to_ms(g_send_ns)) +
            ",\"bytes_sent\":" + std::to_string(g_send_bytes) + "}";
        return frame(text);
    }
};
