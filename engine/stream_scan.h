#pragma once

namespace stream_scan {

// Jobs own their directory metadata, never a pointer into a completed tree or
// an open descriptor. Only immediate subdirectories are retained while a
// directory is enumerated. Completed file records/subtrees are not retained.
class Pool {
    struct Task { FileNode node; uint64_t id; int depth; };
    struct Worker { Pool* pool = nullptr; ScanStats stats; };
    const safe_delete::Root& root_;
    ScanOutput& output_;
    const size_t staging_limit_;
    std::atomic<size_t> staged_bytes_{0};
    std::mutex mutex_;
    std::condition_variable ready_;
    std::deque<Task> queue_;
    size_t outstanding_ = 1;
    size_t queue_peak_ = 1;
    std::array<Worker, parallel_scan::MAX_WORKERS> workers_;

    bool enqueue(Task& task) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!output_.alive() || queue_.size() >= parallel_scan::MAX_PENDING) return false;
        queue_.push_back(std::move(task));
        ++outstanding_;
        queue_peak_ = std::max(queue_peak_, queue_.size());
        ready_.notify_one();
        return true;
    }
    void process(const Task& task, ScanStats& stats) {
        if (!output_.alive()) return;
        ++stats.dirs;
        if (task.depth >= cfg::MAX_DEPTH) { ++stats.errors; return; }
        safe_delete::Fd opened = parallel_scan::open_directory(root_, task.node);
        if (opened.get() < 0) { ++stats.errors; return; }
        SOCKETSWEEP_SCAN_CHECKPOINT("opened", opened.get(), task.node.path.c_str());
        DIR* listing = ::fdopendir(opened.get());
        if (!listing) { ++stats.errors; return; }
        opened.release();
        std::vector<Task> directories;
        struct Staging {
            std::atomic<size_t>& total;
            size_t bytes = 0;
            ~Staging() { total.fetch_sub(bytes); }
            bool reserve(size_t cost, size_t limit) {
                const size_t previous = total.fetch_add(cost);
                if (cost > limit || previous > limit - cost) {
                    total.fetch_sub(cost);
                    return false;
                }
                bytes += cost;
                return true;
            }
        } staging{staged_bytes_};
        while (output_.alive()) {
            errno = 0;
            const auto* entry = ::readdir(listing);
            if (!entry) { if (errno) ++stats.errors; break; }
            const std::string name = entry->d_name;
            if (name == "." || name == "..") continue;
#ifdef DT_LNK
            if (entry->d_type == DT_LNK) continue;
#endif
            FileNode node;
            node.name = name;
            node.path = (task.node.path == "/" ? task.node.path : task.node.path + '/') + name;
            struct stat info{};
            const char* kind = "other";
            bool counted = false;
            if (::fstatat(::dirfd(listing), name.c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0) {
                ++stats.errors;
            } else if (S_ISLNK(info.st_mode)) {
                continue;
            } else if (S_ISDIR(info.st_mode)) {
                node.is_dir = true;
                node.device = info.st_dev;
                node.inode = info.st_ino;
                kind = "directory"; counted = true;
            } else if (S_ISREG(info.st_mode)) {
                if (info.st_size < 0 || stats.total_size > std::numeric_limits<int64_t>::max() - info.st_size) {
                    output_.error("Scan byte total overflow");
                    break;
                }
                node.size = info.st_size;
                ++stats.files; stats.total_size += info.st_size;
                kind = "file"; counted = true;
            }
            uint64_t id = 0;
            if (!output_.entry(node, task.id, kind, counted, id)) break;
            if (node.is_dir) {
                // Include vector growth and owned strings. This shared budget
                // also covers inline fallbacks, not just the queued jobs.
                const size_t cost = 2 * sizeof(Task) + node.path.capacity() + node.name.capacity() + 64;
                if (!staging.reserve(cost, staging_limit_)) {
                    output_.error("Scan directory staging limit exceeded");
                    break;
                }
                directories.push_back({std::move(node), id, task.depth + 1});
            }
        }
        ::closedir(listing);
        // Match the legacy pool's descriptor bound: close before inline
        // fallback, and never wait for queue space (which could deadlock).
        for (auto& child : directories) {
            if (!output_.alive()) break;
            if (!enqueue(child)) process(child, stats);
        }
    }
    void work(ScanStats& stats) {
        while (true) {
            Task task;
            {
                std::unique_lock<std::mutex> lock(mutex_);
                ready_.wait(lock, [&] { return !queue_.empty() || outstanding_ == 0; });
                if (!outstanding_) return;
                task = std::move(queue_.front()); queue_.pop_front();
            }
            process(task, stats);
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (--outstanding_ == 0) ready_.notify_all();
            }
        }
    }
    static void* entry(void* context) {
        auto& worker = *static_cast<Worker*>(context);
        worker.pool->work(worker.stats);
        return nullptr;
    }
public:
    Pool(const safe_delete::Root& root, ScanOutput& output, FileNode node,
         size_t staging_limit = 64 * 1024 * 1024)
        : root_(root), output_(output), staging_limit_(staging_limit) {
        queue_.push_back({std::move(node), 0, 0});
        for (auto& worker : workers_) worker.pool = this;
    }
    size_t queue_peak() const { return queue_peak_; }
    int run(ScanStats& stats, int requested) {
        requested = std::max(1, std::min(requested, parallel_scan::MAX_WORKERS));
        std::array<pthread_t, parallel_scan::MAX_WORKERS - 1> threads{};
        int count = 1;
        for (int i = 1; i < requested; ++i) {
            if (SOCKETSWEEP_SCAN_CREATE_THREAD(&threads[i - 1], nullptr, entry, &workers_[i])) break;
            ++count;
        }
        work(workers_[0].stats);
        for (int i = 1; i < count; ++i) ::pthread_join(threads[i - 1], nullptr);
        for (int i = 0; i < count; ++i) {
            if (stats.total_size > std::numeric_limits<int64_t>::max() - workers_[i].stats.total_size) {
                output_.error("Scan byte total overflow");
                break;
            }
            stats.files += workers_[i].stats.files; stats.dirs += workers_[i].stats.dirs;
            stats.total_size += workers_[i].stats.total_size; stats.errors += workers_[i].stats.errors;
        }
        return count;
    }
};

static void handle(int fd, std::string root) {
    g_scan_root.clear();
    g_send_ns = 0; g_send_bytes = 0;
    ScanOutput output(fd);
    while (root.size() > 1 && root.back() == '/') root.pop_back();
    if (root.empty() || root.front() != '/') { output.error("Scan root must be an absolute directory"); return; }
    if (g_read_only) {
        char* canonical = ::realpath(root.c_str(), nullptr);
        if (!canonical) { output.error("Scan root is not an accessible directory"); return; }
        root = canonical; std::free(canonical);
        if (virtual_filesystem(root)) { output.error("Virtual filesystems are excluded from root scans"); return; }
    }
    safe_delete::Root pending;
    if (!pending.open(root)) { output.error("Scan root is not an accessible directory"); return; }
    if (!output.start(root)) return;
    const auto start = std::chrono::steady_clock::now();
    ScanStats stats;
    int workers = 1;
    const auto position = root.rfind('/');
    const auto name = position + 1 < root.size() ? root.substr(position + 1) : root;
    if (g_read_only) {
        scan(root, name, stats, 0, &output);
    } else {
        FileNode node;
        node.name = name; node.path = root; node.is_dir = true;
        node.device = pending.identity.st_dev; node.inode = pending.identity.st_ino;
        uint64_t id = 0;
        if (!output.entry(node, 0, "directory", true, id)) return;
        Pool pool(pending, output, std::move(node));
        workers = pool.run(stats, g_scan_threads);
    }
    if (!output.alive()) return;
    if (!pending.unchanged()) { output.error("Scan root changed during scan; scan again"); return; }
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
    // A cancelled/failed scan never becomes a daemon deletion root. The host
    // separately validates completion, counts and EOF before authorizing it.
    if (output.finish(stats, elapsed, workers)) g_scan_root = std::move(pending);
}
} // namespace stream_scan
