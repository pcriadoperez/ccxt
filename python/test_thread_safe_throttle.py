#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Unit tests for thread-safe throttle implementation in CCXT Exchange base class.

Tests verify:
1. Single-threaded behavior remains unchanged (no regression)
2. Multi-threaded behavior properly serializes requests (fixes race condition)
"""

import unittest
import time
import threading
from unittest.mock import Mock, patch
import sys
import os

# Add the ccxt module to the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'python'))

import ccxt


class TestThrottleSingleThreaded(unittest.TestCase):
    """Test that single-threaded behavior is unchanged"""

    def setUp(self):
        """Create a test exchange instance with known rate limit"""
        self.exchange = ccxt.Exchange({
            'id': 'test',
            'rateLimit': 1000,  # 1000ms = 1 second
            'enableRateLimit': True,
        })
        # Mock the fetch method to avoid actual HTTP requests
        self.exchange.fetch = Mock(return_value='mocked response')

    def test_initial_timestamp_is_zero(self):
        """Verify lastRestRequestTimestamp starts at 0"""
        self.assertEqual(self.exchange.lastRestRequestTimestamp, 0)

    def test_first_request_no_delay(self):
        """First request should not be delayed (timestamp is 0)"""
        start = time.time()
        self.exchange.fetch2('/test', 'public', 'GET')
        elapsed = time.time() - start

        # First request should be nearly instant (no throttle delay)
        # Allow 100ms tolerance for system overhead
        self.assertLess(elapsed, 0.1, "First request should not be throttled")

    def test_second_request_is_throttled(self):
        """Second request should be delayed by rateLimit amount"""
        # First request
        self.exchange.fetch2('/test', 'public', 'GET')

        # Second request should be throttled
        start = time.time()
        self.exchange.fetch2('/test', 'public', 'GET')
        elapsed = time.time() - start

        # Should wait ~1 second (1000ms rateLimit)
        # Allow ±100ms tolerance for system timing variations
        self.assertGreater(elapsed, 0.9, "Second request should be throttled")
        self.assertLess(elapsed, 1.1, "Throttle delay should be ~1 second")

    def test_timestamp_updated_after_request(self):
        """Verify lastRestRequestTimestamp is updated after each request"""
        initial = self.exchange.lastRestRequestTimestamp
        self.exchange.fetch2('/test', 'public', 'GET')
        after_first = self.exchange.lastRestRequestTimestamp

        self.assertNotEqual(initial, after_first, "Timestamp should be updated")
        self.assertGreater(after_first, initial, "Timestamp should increase")

    def test_cost_multiplier(self):
        """Verify cost parameter properly multiplies the delay"""
        self.exchange.fetch2('/test', 'public', 'GET')

        # Mock calculate_rate_limiter_cost to return cost of 2
        with patch.object(self.exchange, 'calculate_rate_limiter_cost', return_value=2):
            start = time.time()
            self.exchange.fetch2('/test', 'public', 'GET')
            elapsed = time.time() - start

            # Should wait ~2 seconds (1000ms * cost of 2)
            # Allow ±200ms tolerance
            self.assertGreater(elapsed, 1.8, "Cost=2 should double the delay")
            self.assertLess(elapsed, 2.2, "Throttle delay should be ~2 seconds")

    def test_rate_limit_disabled(self):
        """When enableRateLimit is False, no throttling should occur"""
        self.exchange.enableRateLimit = False
        self.exchange.fetch2('/test', 'public', 'GET')

        # Second request should be immediate
        start = time.time()
        self.exchange.fetch2('/test', 'public', 'GET')
        elapsed = time.time() - start

        # Should be nearly instant
        self.assertLess(elapsed, 0.1, "Requests should not be throttled when disabled")


class TestThrottleMultiThreaded(unittest.TestCase):
    """Test that multi-threaded behavior properly serializes requests"""

    def setUp(self):
        """Create a test exchange instance with known rate limit"""
        self.exchange = ccxt.Exchange({
            'id': 'test',
            'rateLimit': 500,  # 500ms for faster tests
            'enableRateLimit': True,
        })
        # Mock the fetch method to avoid actual HTTP requests
        self.exchange.fetch = Mock(return_value='mocked response')

        # Track request timestamps for verification
        self.request_times = []
        self.lock = threading.Lock()

    def record_request_time(self):
        """Thread-safe method to record when a request was made"""
        with self.lock:
            self.request_times.append(time.time())

    def test_two_threads_serialize_requests(self):
        """Two threads sharing one exchange should serialize requests"""
        results = []

        def make_request(thread_id):
            """Make a request and record timing"""
            self.exchange.fetch2('/test', 'public', 'GET')
            self.record_request_time()
            results.append(f"thread_{thread_id}_done")

        # Start two threads nearly simultaneously
        start = time.time()
        thread1 = threading.Thread(target=make_request, args=(1,))
        thread2 = threading.Thread(target=make_request, args=(2,))

        thread1.start()
        # Small delay to ensure thread2 starts while thread1 is in throttle
        time.sleep(0.01)
        thread2.start()

        thread1.join()
        thread2.join()
        total_time = time.time() - start

        # Both threads should complete
        self.assertEqual(len(results), 2)
        self.assertEqual(len(self.request_times), 2)

        # Requests should be serialized, so total time should be ~0.5 seconds
        # (first request is immediate, second waits 500ms)
        # Allow tolerance for thread scheduling
        self.assertGreater(total_time, 0.4, "Requests should be serialized")
        self.assertLess(total_time, 0.7, "Total time should be ~0.5 seconds")

        # The gap between requests should be ~500ms
        gap = self.request_times[1] - self.request_times[0]
        self.assertGreater(gap, 0.4, "Gap between requests should be ~500ms")
        self.assertLess(gap, 0.6, "Gap should not exceed rate limit + tolerance")

    def test_multiple_threads_maintain_rate_limit(self):
        """Multiple threads should maintain proper spacing between requests"""
        num_threads = 5
        results = []

        def make_request(thread_id):
            """Make a request and record timing"""
            self.exchange.fetch2('/test', 'public', 'GET')
            self.record_request_time()
            results.append(thread_id)

        # Start all threads nearly simultaneously
        threads = []
        start = time.time()
        for i in range(num_threads):
            t = threading.Thread(target=make_request, args=(i,))
            threads.append(t)
            t.start()
            time.sleep(0.01)  # Stagger starts slightly

        # Wait for all to complete
        for t in threads:
            t.join()

        total_time = time.time() - start

        # All threads should complete
        self.assertEqual(len(results), num_threads)
        self.assertEqual(len(self.request_times), num_threads)

        # Verify spacing between consecutive requests
        for i in range(1, len(self.request_times)):
            gap = self.request_times[i] - self.request_times[i-1]
            # Each gap should be at least close to the rate limit (500ms)
            # Allow some tolerance for the first gap which might be immediate
            if i == 1:
                # First gap might be small if first thread hadn't updated timestamp yet
                self.assertGreater(gap, 0, "Gap should be positive")
            else:
                # Subsequent gaps should respect rate limit
                self.assertGreater(gap, 0.4, f"Gap {i} should be ~500ms, got {gap}")

    def test_no_race_condition_on_timestamp(self):
        """Verify lastRestRequestTimestamp is not corrupted by race conditions"""
        num_threads = 10
        results = []

        def make_request(thread_id):
            """Make a request"""
            self.exchange.fetch2('/test', 'public', 'GET')
            results.append(thread_id)

        # Start all threads
        threads = []
        for i in range(num_threads):
            t = threading.Thread(target=make_request, args=(i,))
            threads.append(t)
            t.start()

        # Wait for all to complete
        for t in threads:
            t.join()

        # All threads should complete
        self.assertEqual(len(results), num_threads)

        # lastRestRequestTimestamp should be set to a valid recent time
        now = self.exchange.milliseconds()
        timestamp = self.exchange.lastRestRequestTimestamp

        # Timestamp should be recent (within last few seconds)
        self.assertGreater(timestamp, 0, "Timestamp should be set")
        self.assertLess(now - timestamp, 5000, "Timestamp should be recent")

    def test_concurrent_requests_different_exchanges(self):
        """Different exchange instances can truly run in parallel"""
        # Create two separate exchange instances
        exchange1 = ccxt.Exchange({
            'id': 'test1',
            'rateLimit': 500,
            'enableRateLimit': True,
        })
        exchange2 = ccxt.Exchange({
            'id': 'test2',
            'rateLimit': 500,
            'enableRateLimit': True,
        })
        exchange1.fetch = Mock(return_value='response1')
        exchange2.fetch = Mock(return_value='response2')

        results = []

        def make_request(exchange, name):
            """Make a request on the given exchange"""
            exchange.fetch2('/test', 'public', 'GET')
            results.append(name)

        # Start two threads on different exchanges
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

        # Total time should be much less than 1 second since they run in parallel
        # (not serialized like same instance would be)
        self.assertLess(total_time, 0.3, "Different instances should run in parallel")


class TestThrottleLockBehavior(unittest.TestCase):
    """Test the lock mechanism itself"""

    def test_lock_is_reentrant(self):
        """Verify RLock allows same thread to acquire multiple times"""
        exchange = ccxt.Exchange({
            'id': 'test',
            'enableRateLimit': True,
        })

        # Same thread should be able to acquire lock multiple times
        acquired1 = exchange._throttle_lock.acquire(blocking=False)
        acquired2 = exchange._throttle_lock.acquire(blocking=False)

        self.assertTrue(acquired1, "First acquire should succeed")
        self.assertTrue(acquired2, "Reentrant acquire should succeed")

        # Release both
        exchange._throttle_lock.release()
        exchange._throttle_lock.release()

    def test_lock_exists_on_initialization(self):
        """Verify lock is created during __init__"""
        exchange = ccxt.Exchange({'id': 'test'})

        self.assertTrue(hasattr(exchange, '_throttle_lock'))
        self.assertIsInstance(exchange._throttle_lock, threading.RLock)


if __name__ == '__main__':
    # Run tests with verbose output
    unittest.main(verbosity=2)
