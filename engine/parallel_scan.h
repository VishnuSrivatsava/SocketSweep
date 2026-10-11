#pragma once

#include <array>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <pthread.h>

// This hook is compiled out of production builds. Tests replace entries at
// deterministic points rather than relying on timing to exercise races.
#ifndef SOCKETSWEEP_SCAN_CHECKPOINT
#define SOCKETSWEEP_SCAN_CHECKPOINT(event, parent, name) ((void)0)
#endif
#ifndef SOCKETSWEEP_SCAN_CREATE_THREAD
#define SOCKETSWEEP_SCAN_CREATE_THREAD pthread_create
#endif

namespace parallel_scan {

constexpr int MAX_WORKERS = 8;
constexpr size_t MAX_PENDING = 64;

struct Result {
    int workers = 1;
    size_t queue_peak = 0;
    int64_t sort_ns = 0;
};

struct Task {
    FileNode* node;
    int depth;
};

// Only directory jobs enter the queue. Its entries own no descriptors. A
// worker owns its subtree's child vector until enumeration is finished, then
// publishes pointers into that stable vector. Aggregation and sorting happen
// after every worker has joined, so ancestors are never updated concurrently.
class Pool {
    struct Worker {
        Pool* pool = nullptr;
        ScanStats stats;
    };
    const safe_delete::Root& root_;
    int max_depth_;
    std::mutex mutex_;
    std::condition_variable ready_;
    std::deque<Task> queue_;
    size_t outstanding_ = 1; // queued + active jobs, including the root
    size_t queue_peak_ = 1;
    std::array<Worker, MAX_WORKERS> workers_;

    safe_delete::Fd open_directory(const FileNode& node) const {
        // Reopen from the pinned root one component at a time. In particular,
        // opening a queued path must not follow a replaced parent symlink.
        safe_delete::Fd current(::openat(root_.fd.get(), ".",
                                          O_RDONLY | O_DIRECTORY | O_CLOEXEC));
        if (current.get() < 0) return current;
        const size_t prefix = root_.path.size() + (root_.path == "/" ? 0 : 1);
        size_t start = prefix;
        while (start < node.path.size()) {
            size_t end = node.path.find('/', start);
            if (end == std::string::npos) end = node.path.size();
            const std::string name = node.path.substr(start, end - start);
            SOCKETSWEEP_SCAN_CHECKPOINT("before_open", current.get(), name.c_str());
            current.reset(::openat(current.get(), name.c_str(),
                                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
            if (current.get() < 0) return current;
            start = end + 1;
        }
        struct stat actual{};
        if (::fstat(current.get(), &actual) != 0 ||
            actual.st_dev != node.device || actual.st_ino != node.inode) {
            current.reset();
        }
        return current;
    }

    bool enqueue(Task task) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (queue_.size() >= MAX_PENDING) return false;
        queue_.push_back(task);
        ++outstanding_;
        queue_peak_ = std::max(queue_peak_, queue_.size());
        ready_.notify_one();
        return true;
    }

    void process(Task task, ScanStats& stats) {
        FileNode& node = *task.node;
        ++stats.dirs;
        if (task.depth >= max_depth_) { ++stats.errors; return; }
        safe_delete::Fd opened = open_directory(node);
        if (opened.get() < 0) { ++stats.errors; return; }
        SOCKETSWEEP_SCAN_CHECKPOINT("opened", opened.get(), node.path.c_str());
        DIR* listing = ::fdopendir(opened.get());
        if (!listing) { ++stats.errors; return; }
        opened.release(); // fdopendir now owns it
        const int parent = ::dirfd(listing);
        while (true) {
            errno = 0;
            struct dirent* entry = ::readdir(listing);
            if (!entry) {
                if (errno != 0) ++stats.errors;
                break;
            }
            const std::string name = entry->d_name;
            if (name == "." || name == "..") continue;
            #ifdef DT_LNK
            if (entry->d_type == DT_LNK) continue;
            #endif
            FileNode child;
            child.name = name;
            child.path = (node.path == "/" ? node.path : node.path + '/') + name;
            struct stat info{};
            if (::fstatat(parent, name.c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0) {
                ++stats.errors;
            } else if (S_ISLNK(info.st_mode)) {
                continue;
            } else if (S_ISDIR(info.st_mode)) {
                child.is_dir = true;
                child.device = info.st_dev;
                child.inode = info.st_ino;
            } else if (S_ISREG(info.st_mode)) {
                child.size = info.st_size;
                ++stats.files;
                stats.total_size += info.st_size;
            }
            node.children.push_back(std::move(child));
        }
        ::closedir(listing);
        // Release the listing before any recursive fallback. Even at the queue
        // limit, descriptors stay bounded by the worker count rather than the
        // width or depth of the tree. Do not wait for queue space: all workers
        // could otherwise block while no worker remains to consume jobs.
        for (auto& child : node.children) {
            if (child.is_dir) {
                Task next{&child, task.depth + 1};
                if (!enqueue(next)) process(next, stats);
            }
        }
    }

    void work(ScanStats& stats) {
        while (true) {
            Task task{};
            {
                std::unique_lock<std::mutex> lock(mutex_);
                ready_.wait(lock, [&] { return !queue_.empty() || outstanding_ == 0; });
                if (outstanding_ == 0) return;
                task = queue_.front();
                queue_.pop_front();
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

    static void aggregate(FileNode& node, int64_t& sort_ns) {
        if (!node.is_dir) return;
        node.size = 0;
        for (auto& child : node.children) {
            aggregate(child, sort_ns);
            node.size += child.size;
        }
        const auto start = std::chrono::steady_clock::now();
        std::sort(node.children.begin(), node.children.end(),
                  [](const FileNode& a, const FileNode& b) { return a.size > b.size; });
        sort_ns += std::chrono::duration_cast<std::chrono::nanoseconds>(
                       std::chrono::steady_clock::now() - start).count();
    }

public:
    Pool(const safe_delete::Root& root, FileNode& tree, int max_depth)
        : root_(root), max_depth_(max_depth) {
        queue_.push_back({&tree, 0});
        for (auto& worker : workers_) worker.pool = this;
    }

    Result run(FileNode& tree, ScanStats& stats, int requested_workers) {
        Result result;
        std::array<pthread_t, MAX_WORKERS - 1> threads{};
        const int count = std::max(1, std::min(requested_workers, MAX_WORKERS));
        for (int i = 1; i < count; ++i) {
            // pthread_create reports failure without throwing: the daemon is
            // built with -fno-exceptions. Fewer workers still finish all jobs.
            if (SOCKETSWEEP_SCAN_CREATE_THREAD(&threads[i - 1], nullptr, entry,
                                               &workers_[i]) != 0) break;
            ++result.workers;
        }
        work(workers_[0].stats); // the calling thread participates
        for (int i = 1; i < result.workers; ++i) ::pthread_join(threads[i - 1], nullptr);
        for (int i = 0; i < result.workers; ++i) {
            stats.files += workers_[i].stats.files;
            stats.dirs += workers_[i].stats.dirs;
            stats.total_size += workers_[i].stats.total_size;
            stats.errors += workers_[i].stats.errors;
        }
        result.queue_peak = queue_peak_;
        aggregate(tree, result.sort_ns);
        return result;
    }
};

inline Result run(const safe_delete::Root& root, FileNode& tree, ScanStats& stats,
                  int workers, int max_depth) {
    Pool pool(root, tree, max_depth);
    return pool.run(tree, stats, workers);
}

} // namespace parallel_scan
