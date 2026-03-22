package io.github.ccxt;

import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Rate limiter for CCXT exchanges.
 * Supports two algorithms: leakyBucket (default) and rollingWindow.
 * Thread-safe, designed to be called from CompletableFuture async chains.
 */
public class Throttler {

    private static class QueueElement {
        final double cost;
        final CompletableFuture<Void> future;

        QueueElement(double cost, CompletableFuture<Void> future) {
            this.cost = cost;
            this.future = future;
        }
    }

    private static class TimestampedCost {
        final long timestamp;
        final double cost;

        TimestampedCost(long timestamp, double cost) {
            this.timestamp = timestamp;
            this.cost = cost;
        }
    }

    private final LinkedList<QueueElement> queue = new LinkedList<>();
    private final ReentrantLock lock = new ReentrantLock();
    private boolean running = false;

    // Config
    private double refillRate;
    private double delay;
    private double capacity;
    private double tokens;
    private double defaultCost;
    private String algorithm;
    private double windowSize;
    private double maxWeight;

    // Rolling window state
    private final List<TimestampedCost> timestamps = new ArrayList<>();

    @SuppressWarnings("unchecked")
    public Throttler(Object config) {
        // Defaults
        this.refillRate = 1.0;
        this.delay = 0.001;
        this.capacity = 1.0;
        this.tokens = 0;
        this.defaultCost = 1.0;
        this.algorithm = "leakyBucket";
        this.windowSize = 60000.0;
        this.maxWeight = 0.0;

        if (config instanceof Map) {
            Map<String, Object> cfg = (Map<String, Object>) config;
            if (cfg.containsKey("refillRate")) this.refillRate = toDouble(cfg.get("refillRate"));
            if (cfg.containsKey("delay")) this.delay = toDouble(cfg.get("delay"));
            if (cfg.containsKey("capacity")) this.capacity = toDouble(cfg.get("capacity"));
            if (cfg.containsKey("tokens")) this.tokens = toDouble(cfg.get("tokens"));
            if (cfg.containsKey("cost")) this.defaultCost = toDouble(cfg.get("cost"));
            if (cfg.containsKey("algorithm")) this.algorithm = String.valueOf(cfg.get("algorithm"));
            if (cfg.containsKey("windowSize")) this.windowSize = toDouble(cfg.get("windowSize"));
            if (cfg.containsKey("rateLimit")) {
                double rateLimit = toDouble(cfg.get("rateLimit"));
                if (!"leakyBucket".equals(this.algorithm) && rateLimit > 0) {
                    this.maxWeight = this.windowSize / rateLimit;
                }
            }
            if (cfg.containsKey("maxWeight") && cfg.get("maxWeight") != null) {
                double mw = toDouble(cfg.get("maxWeight"));
                if (mw > 0) this.maxWeight = mw;
            }
        }
    }

    /**
     * Throttle with the given cost. Returns a CompletableFuture that completes
     * when the request is allowed to proceed.
     */
    public CompletableFuture<Void> throttle(double cost) {
        CompletableFuture<Void> future = new CompletableFuture<>();
        QueueElement element = new QueueElement(cost, future);

        lock.lock();
        try {
            queue.add(element);
            if (!running) {
                running = true;
                Thread.ofVirtual().start(this::loop);
            }
        } finally {
            lock.unlock();
        }

        return future;
    }

    /**
     * Throttle with default cost.
     */
    public CompletableFuture<Void> throttle() {
        return throttle(this.defaultCost);
    }

    private void loop() {
        if ("leakyBucket".equals(this.algorithm)) {
            leakyBucketLoop();
        } else {
            rollingWindowLoop();
        }
    }

    private void leakyBucketLoop() {
        long lastTimestamp = milliseconds();

        while (true) {
            QueueElement first;
            lock.lock();
            try {
                if (queue.isEmpty()) {
                    running = false;
                    return;
                }
                first = queue.peek();
            } finally {
                lock.unlock();
            }

            lock.lock();
            double currentTokens;
            try {
                currentTokens = this.tokens;
            } finally {
                lock.unlock();
            }

            if (currentTokens >= 0) {
                lock.lock();
                try {
                    this.tokens -= first.cost;
                } finally {
                    lock.unlock();
                }
                first.future.complete(null);
                lock.lock();
                try {
                    queue.poll();
                } finally {
                    lock.unlock();
                }
            } else {
                long sleepMs = (long) (this.delay * 1000);
                if (sleepMs > 0) {
                    try { Thread.sleep(sleepMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
                }
                long current = milliseconds();
                long elapsed = current - lastTimestamp;
                lastTimestamp = current;

                lock.lock();
                try {
                    double newTokens = this.tokens + (this.refillRate * elapsed);
                    this.tokens = Math.min(newTokens, this.capacity);
                } finally {
                    lock.unlock();
                }
            }
        }
    }

    private void rollingWindowLoop() {
        while (true) {
            QueueElement first;
            lock.lock();
            try {
                if (queue.isEmpty()) {
                    running = false;
                    return;
                }
                first = queue.peek();
            } finally {
                lock.unlock();
            }

            long now = milliseconds();

            lock.lock();
            try {
                // Remove expired timestamps and sum remaining
                long cutoff = now - (long) windowSize;
                timestamps.removeIf(t -> t.timestamp <= cutoff);
                double totalCost = timestamps.stream().mapToDouble(t -> t.cost).sum();

                if (totalCost + first.cost <= maxWeight) {
                    timestamps.add(new TimestampedCost(now, first.cost));
                    lock.unlock();

                    first.future.complete(null);
                    lock.lock();
                    try {
                        queue.poll();
                    } finally {
                        lock.unlock();
                    }
                } else {
                    long waitTime = 0;
                    if (!timestamps.isEmpty()) {
                        waitTime = (timestamps.get(0).timestamp + (long) windowSize) - now;
                    }
                    lock.unlock();

                    if (waitTime > 0) {
                        try { Thread.sleep(waitTime); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
                    }
                }
            } catch (Exception e) {
                lock.unlock();
                throw e;
            }
        }
    }

    private static long milliseconds() {
        return System.currentTimeMillis();
    }

    private static double toDouble(Object v) {
        if (v == null) return 0.0;
        if (v instanceof Number n) return n.doubleValue();
        try { return Double.parseDouble(String.valueOf(v)); } catch (Exception e) { return 0.0; }
    }
}
