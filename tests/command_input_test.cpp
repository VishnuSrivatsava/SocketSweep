#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <poll.h>
#include <sys/socket.h>
#include <thread>
#include <vector>

// Instrument real syscalls in this test translation unit, without production hooks.
static std::atomic<size_t> receive_calls{0}, poll_calls{0};
static size_t peek_limit = 4096, consume_limit = 4096;
static int peek_faults = 0, consume_faults = 0, poll_interrupts = 0;
static bool simulated_timeout = false, record_timeouts = false;
static std::vector<int> timeouts;

static ssize_t measured_recv(int fd, void* buffer, size_t length, int flags) {
    ++receive_calls;
    const bool peek = (flags & MSG_PEEK) != 0;
    int& faults = peek ? peek_faults : consume_faults;
    if (faults > 0) {
        errno = --faults % 2 ? EINTR : EAGAIN;
        return -1;
    }
    const size_t cap = peek ? peek_limit : consume_limit;
    return ::recv(fd, buffer, length < cap ? length : cap, flags);
}

static int measured_poll(struct pollfd* fds, nfds_t count, int timeout) {
    ++poll_calls;
    if (record_timeouts) timeouts.push_back(timeout);
    if (poll_interrupts > 0) {
        --poll_interrupts;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        errno = EINTR;
        return -1;
    }
    if (simulated_timeout) return 0;
    return ::poll(fds, count, timeout);
}

#define recv measured_recv
#define poll measured_poll
#define main daemon_main
#include "../engine/daemon.cpp"
#undef main
#undef poll
#undef recv

static void require(bool ok, const char* message) {
    if (!ok) { std::fprintf(stderr, "%s\n", message); std::exit(1); }
}

struct Sockets {
    safe_delete::Fd reader, writer;
    Sockets() {
        int pair[2];
        require(::socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0, "socketpair failed");
        reader.reset(pair[0]); writer.reset(pair[1]);
        int capacity = 128 * 1024;
        require(::setsockopt(writer.get(), SOL_SOCKET, SO_SNDBUF, &capacity, sizeof(capacity)) == 0,
                "socket buffer setup failed");
    }
    void write(const std::string& data) {
        require(JsonStream::send_all(writer.get(), data.data(), data.size()), "fixture write failed");
    }
};

static const std::string auth = "AUTH " + std::string(64, 'a');

static void coalesced() {
    Sockets sockets;
    sockets.write(auth + "\nPING\nSHUTDOWN\n");
    std::string line;
    require(recv_line(sockets.reader.get(), line) && line == auth, "AUTH framing changed");
    require(recv_line(sockets.reader.get(), line) && line == "PING", "command framing changed");
    require(receive_calls <= 6 && poll_calls <= 3, "reader still performs per-byte syscalls");
    char extra[16];
    const auto n = ::recv(sockets.reader.get(), extra, sizeof(extra), MSG_PEEK | MSG_DONTWAIT);
    require(n == 9 && std::string(extra, static_cast<size_t>(n)) == "SHUTDOWN\n",
            "surplus bytes disappeared from the socket");
}

static void splits() {
    const std::string command = u8"DELETE /storage/ 写真 trailing ";
    for (size_t cap = 1; cap <= auth.size() + command.size(); ++cap) {
        peek_limit = cap;
        consume_limit = cap % 7 + 1;
        Sockets sockets;
        sockets.write(auth + "\n" + command + "\nNEXT\n");
        std::string line;
        require(recv_line(sockets.reader.get(), line) && line == auth, "split AUTH changed");
        require(recv_line(sockets.reader.get(), line) && line == command, "split path bytes changed");
        require(recv_line(sockets.reader.get(), line) && line == "NEXT", "split surplus lost");
    }
}

static void bounds() {
    for (size_t length : {size_t(0), size_t(1), size_t(4095), size_t(4096), size_t(4097),
                          cfg::MAX_COMMAND_BYTES - 1, cfg::MAX_COMMAND_BYTES, cfg::MAX_COMMAND_BYTES + 1}) {
        Sockets sockets;
        const std::string expected(length, 'x');
        sockets.write(expected + "\nNEXT\n");
        std::string line;
        const bool valid = recv_line(sockets.reader.get(), line);
        require(valid == (length <= cfg::MAX_COMMAND_BYTES), "line bound changed");
        require(line.size() <= cfg::MAX_COMMAND_BYTES, "line grew beyond its bound");
        if (valid) {
            require(line == expected, "bounded line changed");
            require(recv_line(sockets.reader.get(), line) && line == "NEXT", "boundary lost next line");
        }
    }
}

static void invalid() {
    for (char bad : {'\r', '\0'}) {
        for (size_t position : {size_t(0), size_t(4095), size_t(4096), cfg::MAX_COMMAND_BYTES - 1}) {
            Sockets sockets;
            std::string data(cfg::MAX_COMMAND_BYTES, 'x');
            data[position] = bad;
            sockets.write(data + "\nNEXT\n");
            std::string line;
            require(!recv_line(sockets.reader.get(), line), "invalid delimiter accepted");
        }
    }
    for (const auto& data : {std::string(), std::string("PING")}) {
        Sockets sockets;
        sockets.write(data);
        require(::shutdown(sockets.writer.get(), SHUT_WR) == 0, "half-close failed");
        std::string line;
        require(!recv_line(sockets.reader.get(), line), "EOF accepted as a newline");
    }
}

static void interruptions() {
    Sockets sockets;
    sockets.write(auth + "\nPING\n");
    peek_faults = consume_faults = 2;
    std::string line;
    require(recv_line(sockets.reader.get(), line) && line == auth, "interrupted AUTH changed");
    require(recv_line(sockets.reader.get(), line) && line == "PING", "interrupted command changed");
    require(peek_faults == 0 && consume_faults == 0, "retry paths not exercised");
}

static void deadline() {
    Sockets sockets;
    poll_interrupts = 2;
    simulated_timeout = record_timeouts = true;
    std::string line;
    require(!recv_line(sockets.reader.get(), line), "poll timeout did not fail the read");
    require(timeouts.size() == 3 && timeouts.front() <= cfg::RECV_TIMEOUT_SEC * 1000 &&
            timeouts.back() < timeouts.front() - 10, "interruptions reset the absolute deadline");
    require(receive_calls == 0, "read attempted after timeout");
}

static void dispatch() {
    g_session_token = std::string(64, 'a');
    for (const auto& request : {auth + "\nPING\nSHUTDOWN\n", std::string("AUTH wrong\nSHUTDOWN\n")}) {
        Sockets sockets;
        sockets.write(request);
        handle_client(sockets.reader.get());
        require(g_running == 1, "extra or unauthenticated command was dispatched");
        char response[512];
        const auto n = ::recv(sockets.writer.get(), response, sizeof(response), MSG_DONTWAIT);
        require(n > 0, "dispatch response missing");
        const std::string text(response, static_cast<size_t>(n));
        require(text.find(request == auth + "\nPING\nSHUTDOWN\n" ? "pong" : "Authentication failed") !=
                std::string::npos, "dispatch semantics changed");
    }
}

static void stream_extra() {
    char pattern[] = "/tmp/socketsweep-command-XXXXXX";
    char* root = ::mkdtemp(pattern);
    require(root != nullptr, "root fixture setup failed");
    g_session_token = std::string(64, 'a');
    for (const auto& extra : {std::string("SHUTDOWN\n"), std::string("\0", 1),
                              std::string("\r\n"), std::string("x")}) {
        require(g_scan_root.open(root), "previous root fixture setup failed");
        Sockets sockets;
        sockets.write(auth + "\nSCAN_STREAM " + root + "\n" + extra);
        handle_client(sockets.reader.get());
        require(g_running == 1 && g_scan_root.fd.get() < 0, "extra stream enabled dispatch or deletion");
        char byte;
        const auto n = ::recv(sockets.writer.get(), &byte, 1, MSG_DONTWAIT);
        require(n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK), "extra stream published data");
    }
    require(::rmdir(root) == 0, "root fixture cleanup failed");
}

static void benchmark(int iterations, size_t length) {
    require(iterations > 0 && length >= 4 && length <= cfg::MAX_COMMAND_BYTES, "bad benchmark arguments");
    Sockets sockets;
    const std::string command = length == 4 ? "PING" : std::string(length, 'x');
    const std::string request = auth + "\n" + command + "\n";
    std::string line;
    const auto start = std::chrono::steady_clock::now();
    for (int i = 0; i < iterations; ++i) {
        sockets.write(request);
        require(recv_line(sockets.reader.get(), line) && line == auth, "benchmark AUTH changed");
        require(recv_line(sockets.reader.get(), line) && line == command, "benchmark command changed");
    }
    const auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    std::printf("{\"iterations\":%d,\"request_bytes\":%zu,\"recv_calls\":%zu,\"poll_calls\":%zu,\"wall_ms\":%.3f}\n",
                iterations, request.size(), receive_calls.load(), poll_calls.load(), elapsed);
}

int main(int argc, char** argv) {
    require(argc >= 2, "missing case");
    const std::string name = argv[1];
    if (name == "coalesced") coalesced();
    else if (name == "splits") splits();
    else if (name == "bounds") bounds();
    else if (name == "invalid") invalid();
    else if (name == "interruptions") interruptions();
    else if (name == "deadline") deadline();
    else if (name == "dispatch") dispatch();
    else if (name == "stream_extra") stream_extra();
    else if (name == "benchmark" && argc == 4) benchmark(std::atoi(argv[2]), static_cast<size_t>(std::atoi(argv[3])));
    else require(false, "unknown case");
}
