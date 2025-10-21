#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Standalone unit tests for thread-safe throttle implementation.

This test file creates a minimal Exchange mock to test the throttle logic
without requiring all CCXT dependencies.
"""

import unittest
import time
import threading
from unittest.mock import Mock


class MinimalExchange:
    """Minimal Exchange class with just the throttle logic"""

    def __init__(self, rate_limit=1000, enable_rate_limit=True):
        self.rateLimit = rate_limit
        self.enableRateLimit = enable_rate_limit
        self.lastRestRequestTimestamp = 0
        self._throttle_lock = threading.RLock()

    def milliseconds(self):
        """Return current time in milliseconds"""
        return int(time.time() * 1000)

    def throttle(self, cost=None):
        """Rate limiting mechanism"""
        now = float(self.milliseconds())
        elapsed = now - self.lastRestRequestTimestamp
        cost = 1 if cost is None else cost
        sleep_time = self.rateLimit * cost
        if elapsed < sleep_time:
            delay = sleep_time - elapsed
            time.sleep(delay / 1000.0)

    def fetch2(self, path, cost=1):
        """Simplified fetch2 with thread-safe throttling"""
        if self.enableRateLimit:
            # Thread-safe throttling: acquire lock before reading/updating lastRestRequestTimestamp
            with self._throttle_lock:
                self.throttle(cost)
                self.lastRestRequestTimestamp = self.milliseconds()
        else:
            self.lastRestRequestTimestamp = self.milliseconds()
        # Simulate HTTP request
        return f"response for {path}"


class TestThrottleSingleThreaded(unittest.TestCase):
    """Test that single-threaded behavior is correct"""

    def setUp(self):
        """Create a test exchange instance"""
        self.exchange = MinimalExchange(rate_limit=1000, enable_rate_limit=True)

    def test_initial_timestamp_is_zero(self):
        """Verify lastRestRequestTimestamp starts at 0"""
        self.assertEqual(self.exchange.lastRestRequestTimestamp, 0)

    def test_first_request_no_delay(self):
        """First request should not be delayed"""
        start = time.time()
        self.exchange.fetch2('/test')
        elapsed = time.time() - start

        # First request should be nearly instant
        self.assertLess(elapsed, 0.1, "First request should not be throttled")

    def test_second_request_is_throttled(self):
        """Second request should be delayed by rateLimit amount"""
        # First request
        self.exchange.fetch2('/test')

        # Second request should be throttled
        start = time.time()
        self.exchange.fetch2('/test')
        elapsed = time.time() - start

        # Should wait ~1 second (1000ms rateLimit)
        self.assertGreater(elapsed, 0.9, "Second request should be throttled")
        self.assertLess(elapsed, 1.1, "Throttle delay should be ~1 second")

    def test_timestamp_updated_after_request(self):
        """Verify lastRestRequestTimestamp is updated"""
        initial = self.exchange.lastRestRequestTimestamp
        self.exchange.fetch2('/test')
        after_first = self.exchange.lastRestRequestTimestamp

        self.assertNotEqual(initial, after_first)
        self.assertGreater(after_first, initial)

    def test_cost_multiplier(self):
        """Verify cost parameter multiplies the delay"""
        self.exchange.fetch2('/test', cost=1)

        start = time.time()
        self.exchange.fetch2('/test', cost=2)
        elapsed = time.time() - start

        # Should wait ~2 seconds (1000ms * cost of 2)
        self.assertGreater(elapsed, 1.8, "Cost=2 should double the delay")
        self.assertLess(elapsed, 2.2, "Throttle delay should be ~2 seconds")

    def test_rate_limit_disabled(self):
        """When enableRateLimit is False, no throttling"""
        self.exchange.enableRateLimit = False
        self.exchange.fetch2('/test')

        start = time.time()
        self.exchange.fetch2('/test')
        elapsed = time.time() - start

        self.assertLess(elapsed, 0.1, "Should not throttle when disabled")


class TestThrottleMultiThreaded(unittest.TestCase):
    """Test that multi-threaded behavior properly serializes requests"""

    def setUp(self):
        """Create a test exchange instance"""
        self.exchange = MinimalExchange(rate_limit=500, enable_rate_limit=True)
        self.request_times = []
        self.lock = threading.Lock()

    def record_request_time(self):
        """Thread-safe method to record request timestamps"""
        with self.lock:
            self.request_times.append(time.time())

    def test_two_threads_serialize_requests(self):
        """Two threads sharing one exchange should serialize requests"""
        results = []

        def make_request(thread_id):
            self.exchange.fetch2('/test')
            self.record_request_time()
            results.append(f"thread_{thread_id}")

        # Start two threads nearly simultaneously
        start = time.time()
        thread1 = threading.Thread(target=make_request, args=(1,))
        thread2 = threading.Thread(target=make_request, args=(2,))

        thread1.start()
        time.sleep(0.01)  # Ensure thread2 starts while thread1 is in throttle
        thread2.start()

        thread1.join()
        thread2.join()
        total_time = time.time() - start

        # Both threads should complete
        self.assertEqual(len(results), 2)
        self.assertEqual(len(self.request_times), 2)

        # Requests should be serialized (~0.5s total)
        self.assertGreater(total_time, 0.4, "Requests should be serialized")
        self.assertLess(total_time, 0.7, "Total time should be ~0.5 seconds")

        # Gap between requests should be ~500ms
        gap = self.request_times[1] - self.request_times[0]
        self.assertGreater(gap, 0.4, "Gap should be ~500ms")
        self.assertLess(gap, 0.6, "Gap should not exceed rate limit")

    def test_multiple_threads_maintain_rate_limit(self):
        """Multiple threads should maintain proper spacing"""
        num_threads = 5
        results = []

        def make_request(thread_id):
            self.exchange.fetch2('/test')
            self.record_request_time()
            results.append(thread_id)

        # Start all threads
        threads = []
        for i in range(num_threads):
            t = threading.Thread(target=make_request, args=(i,))
            threads.append(t)
            t.start()
            time.sleep(0.01)

        for t in threads:
            t.join()

        # All threads should complete
        self.assertEqual(len(results), num_threads)
        self.assertEqual(len(self.request_times), num_threads)

        # Verify spacing between consecutive requests
        for i in range(1, len(self.request_times)):
            gap = self.request_times[i] - self.request_times[i-1]
            if i > 1:  # Skip first gap which might be small
                self.assertGreater(gap, 0.4, f"Gap {i} should be ~500ms, got {gap:.3f}")

    def test_no_race_condition_on_timestamp(self):
        """Verify no race conditions on lastRestRequestTimestamp"""
        num_threads = 10
        results = []

        def make_request(thread_id):
            self.exchange.fetch2('/test')
            results.append(thread_id)

        # Start all threads
        threads = []
        for i in range(num_threads):
            t = threading.Thread(target=make_request, args=(i,))
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # All should complete
        self.assertEqual(len(results), num_threads)

        # Timestamp should be valid and recent
        now = self.exchange.milliseconds()
        timestamp = self.exchange.lastRestRequestTimestamp

        self.assertGreater(timestamp, 0)
        self.assertLess(now - timestamp, 5000, "Timestamp should be recent")

    def test_concurrent_requests_different_instances(self):
        """Different exchange instances can run in parallel"""
        exchange1 = MinimalExchange(rate_limit=500, enable_rate_limit=True)
        exchange2 = MinimalExchange(rate_limit=500, enable_rate_limit=True)

        results = []

        def make_request(exchange, name):
            exchange.fetch2('/test')
            results.append(name)

        start = time.time()
        thread1 = threading.Thread(target=make_request, args=(exchange1, 'ex1'))
        thread2 = threading.Thread(target=make_request, args=(exchange2, 'ex2'))

        thread1.start()
        thread2.start()
        thread1.join()
        thread2.join()

        total_time = time.time() - start

        # Both should complete
        self.assertEqual(len(results), 2)

        # Should be much faster than serialized (< 0.3s vs ~0.5s)
        self.assertLess(total_time, 0.3, "Different instances run in parallel")


class TestThrottleWithoutLock(unittest.TestCase):
    """Test to demonstrate the race condition WITHOUT the lock"""

    def test_race_condition_without_lock(self):
        """
        Demonstrate that WITHOUT a lock, race conditions can occur.
        This test creates a broken version to show the problem.
        """

        class BrokenExchange:
            """Exchange WITHOUT thread-safe throttling"""

            def __init__(self):
                self.rateLimit = 500
                self.enableRateLimit = True
                self.lastRestRequestTimestamp = 0

            def milliseconds(self):
                return int(time.time() * 1000)

            def throttle(self, cost=None):
                now = float(self.milliseconds())
                elapsed = now - self.lastRestRequestTimestamp
                cost = 1 if cost is None else cost
                sleep_time = self.rateLimit * cost
                if elapsed < sleep_time:
                    delay = sleep_time - elapsed
                    time.sleep(delay / 1000.0)

            def fetch2_broken(self, path):
                """Broken version without lock"""
                if self.enableRateLimit:
                    self.throttle()
                    # Small delay to make race more likely
                    time.sleep(0.001)
                    self.lastRestRequestTimestamp = self.milliseconds()
                return f"response for {path}"

        exchange = BrokenExchange()
        request_times = []
        lock = threading.Lock()

        def record_time():
            with lock:
                request_times.append(time.time())

        def make_request():
            exchange.fetch2_broken('/test')
            record_time()

        # Launch multiple threads
        threads = []
        for i in range(3):
            t = threading.Thread(target=make_request)
            threads.append(t)
            t.start()
            time.sleep(0.01)

        for t in threads:
            t.join()

        # With race condition, the gaps might be incorrect
        # This test just demonstrates the scenario - actual behavior is non-deterministic
        print(f"\nWithout lock - Request times: {request_times}")
        if len(request_times) >= 2:
            gaps = [request_times[i] - request_times[i-1] for i in range(1, len(request_times))]
            print(f"Gaps between requests: {[f'{g:.3f}s' for g in gaps]}")
            print("Note: Some gaps may be smaller than expected due to race condition")


class TestLockBehavior(unittest.TestCase):
    """Test the lock mechanism itself"""

    def test_lock_is_reentrant(self):
        """Verify RLock allows same thread to acquire multiple times"""
        exchange = MinimalExchange()

        acquired1 = exchange._throttle_lock.acquire(blocking=False)
        acquired2 = exchange._throttle_lock.acquire(blocking=False)

        self.assertTrue(acquired1)
        self.assertTrue(acquired2)

        exchange._throttle_lock.release()
        exchange._throttle_lock.release()

    def test_lock_exists(self):
        """Verify lock is created"""
        exchange = MinimalExchange()

        self.assertTrue(hasattr(exchange, '_throttle_lock'))
        # RLock is acquired/released, so just check it has those methods
        self.assertTrue(callable(getattr(exchange._throttle_lock, 'acquire', None)))
        self.assertTrue(callable(getattr(exchange._throttle_lock, 'release', None)))


if __name__ == '__main__':
    print("=" * 70)
    print("Testing Thread-Safe Throttle Implementation")
    print("=" * 70)
    unittest.main(verbosity=2)
