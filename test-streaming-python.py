"""
Tests for the Python event streaming infrastructure in ccxt.
Tests the Stream, Consumer, and Message classes without live exchange connections.
"""

import os
import sys
import asyncio
import traceback

# Add the project root so we can import ccxt modules
root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, root)

from ccxt.async_support.base.ws.stream import Stream
from ccxt.async_support.base.ws.consumer import Consumer
from ccxt.base.types import Message
from ccxt.base.errors import ConsumerFunctionError

passed = 0
failed = 0
errors_list = []


def report(name, success, error=None):
    global passed, failed
    if success:
        passed += 1
        print(f"  PASS: {name}")
    else:
        failed += 1
        errors_list.append((name, error))
        print(f"  FAIL: {name}")
        if error:
            print(f"        {error}")


# ===========================================================================
# 1. Basic stream_produce and subscribe flow
# ===========================================================================

def test_produce_creates_message():
    """Producing a message should store it in message history."""
    s = Stream()
    s.produce('topic1', 'payload1')
    msgs = s.get_message_history('topic1')
    try:
        assert len(msgs) == 1
        assert msgs[0].payload == 'payload1'
        assert msgs[0].error is None
        assert msgs[0].metadata.topic == 'topic1'
        assert msgs[0].metadata.index == 0
        report("produce creates message with correct fields", True)
    except AssertionError as e:
        report("produce creates message with correct fields", False, str(e))


def test_produce_with_error():
    """Producing a message with an error should store both payload and error."""
    s = Stream()
    s.produce('topic1', 'payload1', error='some error')
    msgs = s.get_message_history('topic1')
    try:
        assert len(msgs) == 1
        assert msgs[0].payload == 'payload1'
        assert msgs[0].error == 'some error'
        report("produce with error stores both payload and error", True)
    except AssertionError as e:
        report("produce with error stores both payload and error", False, str(e))


def test_produce_increments_index():
    """Each produce should increment the topic index."""
    s = Stream()
    s.produce('t', 'a')
    s.produce('t', 'b')
    s.produce('t', 'c')
    msgs = s.get_message_history('t')
    try:
        assert msgs[0].metadata.index == 0
        assert msgs[1].metadata.index == 1
        assert msgs[2].metadata.index == 2
        report("produce increments index correctly", True)
    except AssertionError as e:
        report("produce increments index correctly", False, str(e))


def test_produce_independent_topic_indexes():
    """Different topics should have independent indexes."""
    s = Stream()
    s.produce('a', 'x')
    s.produce('a', 'y')
    s.produce('b', 'z')
    try:
        assert s.get_message_history('a')[1].metadata.index == 1
        assert s.get_message_history('b')[0].metadata.index == 0
        report("topics have independent indexes", True)
    except AssertionError as e:
        report("topics have independent indexes", False, str(e))


async def test_subscribe_receives_messages():
    """A subscriber should receive messages produced after subscribing."""
    s = Stream()
    received = []

    def consumer(message: Message):
        received.append(message.payload)

    s.subscribe('t', consumer)
    s.produce('t', 'hello')
    await asyncio.sleep(0.1)
    try:
        assert received == ['hello'], f"Expected ['hello'], got {received}"
        report("subscriber receives messages", True)
    except AssertionError as e:
        report("subscriber receives messages", False, str(e))


async def test_subscribe_does_not_receive_prior_messages():
    """A subscriber added after messages were produced should not receive old messages."""
    s = Stream()
    received = []

    def consumer(message: Message):
        received.append(message.payload)

    s.produce('t', 'old_message')
    s.subscribe('t', consumer)
    s.produce('t', 'new_message')
    await asyncio.sleep(0.1)
    try:
        assert received == ['new_message'], f"Expected ['new_message'], got {received}"
        report("subscriber does not receive prior messages", True)
    except AssertionError as e:
        report("subscriber does not receive prior messages", False, str(e))


async def test_async_consumer():
    """An async consumer function should be awaited properly."""
    s = Stream()
    received = []

    async def consumer(message: Message):
        await asyncio.sleep(0.01)
        received.append(message.payload)

    s.subscribe('t', consumer)
    s.produce('t', 'async_payload')
    await asyncio.sleep(0.2)
    try:
        assert received == ['async_payload'], f"Expected ['async_payload'], got {received}"
        report("async consumer receives messages", True)
    except AssertionError as e:
        report("async consumer receives messages", False, str(e))


# ===========================================================================
# 2. Null/undefined payload handling
# ===========================================================================

async def test_none_payload():
    """Producing a message with None payload should work."""
    s = Stream()
    received = []

    def consumer(message: Message):
        received.append(message.payload)

    s.subscribe('t', consumer)
    s.produce('t', None)
    await asyncio.sleep(0.1)
    try:
        assert len(received) == 1
        assert received[0] is None
        report("None payload is delivered correctly", True)
    except AssertionError as e:
        report("None payload is delivered correctly", False, str(e))


async def test_empty_string_payload():
    """Producing a message with empty string payload should work."""
    s = Stream()
    received = []

    def consumer(message: Message):
        received.append(message.payload)

    s.subscribe('t', consumer)
    s.produce('t', '')
    await asyncio.sleep(0.1)
    try:
        assert len(received) == 1
        assert received[0] == ''
        report("empty string payload is delivered correctly", True)
    except AssertionError as e:
        report("empty string payload is delivered correctly", False, str(e))


async def test_dict_payload():
    """Producing a message with a dict payload (typical for trade/ticker data)."""
    s = Stream()
    received = []
    payload = {'symbol': 'BTC/USDT', 'price': 50000, 'amount': 1.5}

    def consumer(message: Message):
        received.append(message.payload)

    s.subscribe('t', consumer)
    s.produce('t', payload)
    await asyncio.sleep(0.1)
    try:
        assert len(received) == 1
        assert received[0] is payload
        assert received[0]['symbol'] == 'BTC/USDT'
        report("dict payload is delivered correctly", True)
    except AssertionError as e:
        report("dict payload is delivered correctly", False, str(e))


# ===========================================================================
# 3. Multiple subscribers
# ===========================================================================

async def test_multiple_subscribers_same_topic():
    """Multiple subscribers to the same topic should all receive messages."""
    s = Stream()
    received1 = []
    received2 = []
    received3 = []

    def consumer1(msg: Message):
        received1.append(msg.payload)

    def consumer2(msg: Message):
        received2.append(msg.payload)

    def consumer3(msg: Message):
        received3.append(msg.payload)

    s.subscribe('t', consumer1)
    s.subscribe('t', consumer2)
    s.subscribe('t', consumer3)
    s.produce('t', 'hello')
    await asyncio.sleep(0.1)
    try:
        assert received1 == ['hello']
        assert received2 == ['hello']
        assert received3 == ['hello']
        report("multiple subscribers all receive messages", True)
    except AssertionError as e:
        report("multiple subscribers all receive messages", False, str(e))


async def test_subscribers_different_topics():
    """Subscribers to different topics should only receive their topic's messages."""
    s = Stream()
    received_a = []
    received_b = []

    def consumer_a(msg: Message):
        received_a.append(msg.payload)

    def consumer_b(msg: Message):
        received_b.append(msg.payload)

    s.subscribe('a', consumer_a)
    s.subscribe('b', consumer_b)
    s.produce('a', 'msg_a')
    s.produce('b', 'msg_b')
    await asyncio.sleep(0.1)
    try:
        assert received_a == ['msg_a']
        assert received_b == ['msg_b']
        report("subscribers only receive their topic's messages", True)
    except AssertionError as e:
        report("subscribers only receive their topic's messages", False, str(e))


async def test_unsubscribe():
    """After unsubscribing, a consumer should no longer receive messages."""
    s = Stream()
    received = []

    def consumer(msg: Message):
        received.append(msg.payload)

    s.subscribe('t', consumer)
    s.produce('t', 'before')
    await asyncio.sleep(0.1)
    s.unsubscribe('t', consumer)
    s.produce('t', 'after')
    await asyncio.sleep(0.1)
    try:
        assert received == ['before'], f"Expected ['before'], got {received}"
        report("unsubscribed consumer stops receiving", True)
    except AssertionError as e:
        report("unsubscribed consumer stops receiving", False, str(e))


def test_unsubscribe_nonexistent_topic():
    """Unsubscribing from a non-existent topic should return False."""
    s = Stream()

    def consumer(msg: Message):
        pass

    result = s.unsubscribe('nonexistent', consumer)
    try:
        assert result is False
        report("unsubscribe from nonexistent topic returns False", True)
    except AssertionError as e:
        report("unsubscribe from nonexistent topic returns False", False, str(e))


async def test_unsubscribe_one_of_multiple():
    """Unsubscribing one consumer should not affect other consumers on the same topic."""
    s = Stream()
    received1 = []
    received2 = []

    def consumer1(msg: Message):
        received1.append(msg.payload)

    def consumer2(msg: Message):
        received2.append(msg.payload)

    s.subscribe('t', consumer1)
    s.subscribe('t', consumer2)
    s.unsubscribe('t', consumer1)
    s.produce('t', 'test')
    await asyncio.sleep(0.1)
    try:
        assert received1 == [], f"Consumer1 should not receive, got {received1}"
        assert received2 == ['test'], f"Consumer2 should receive, got {received2}"
        report("unsubscribing one consumer preserves others", True)
    except AssertionError as e:
        report("unsubscribing one consumer preserves others", False, str(e))


# ===========================================================================
# 4. Error handling in consumers
# ===========================================================================

async def test_consumer_error_produces_to_errors_topic():
    """When a sync consumer throws, the error should be wrapped in ConsumerFunctionError and produced to 'errors' topic."""
    s = Stream()
    error_messages = []

    def bad_consumer(msg: Message):
        raise ValueError("something went wrong")

    def error_handler(msg: Message):
        error_messages.append(msg)

    s.subscribe('errors', error_handler)
    s.subscribe('data', bad_consumer)
    s.produce('data', 'trigger_error')
    await asyncio.sleep(0.2)
    try:
        assert len(error_messages) >= 1, f"Expected error message, got {len(error_messages)}"
        err_msg = error_messages[0]
        assert isinstance(err_msg.error, ConsumerFunctionError), f"Expected ConsumerFunctionError, got {type(err_msg.error)}"
        # The original message should be the payload of the error message
        assert err_msg.payload is not None, "Error message payload should contain the original message"
        report("consumer error produces ConsumerFunctionError to errors topic", True)
    except AssertionError as e:
        report("consumer error produces ConsumerFunctionError to errors topic", False, str(e))


async def test_async_consumer_error_produces_to_errors_topic():
    """When an async consumer throws, the error should also be caught and produced to 'errors' topic."""
    s = Stream()
    error_messages = []

    async def bad_async_consumer(msg: Message):
        raise RuntimeError("async failure")

    def error_handler(msg: Message):
        error_messages.append(msg)

    s.subscribe('errors', error_handler)
    s.subscribe('data', bad_async_consumer)
    s.produce('data', 'trigger_async_error')
    await asyncio.sleep(0.3)
    try:
        assert len(error_messages) >= 1, f"Expected error message, got {len(error_messages)}"
        err_msg = error_messages[0]
        assert isinstance(err_msg.error, ConsumerFunctionError), f"Expected ConsumerFunctionError, got {type(err_msg.error)}"
        report("async consumer error produces ConsumerFunctionError to errors topic", True)
    except AssertionError as e:
        report("async consumer error produces ConsumerFunctionError to errors topic", False, str(e))


async def test_consumer_error_does_not_crash_stream():
    """A consumer error should not prevent other consumers from receiving messages."""
    s = Stream()
    received = []

    def bad_consumer(msg: Message):
        raise Exception("I crash")

    def good_consumer(msg: Message):
        received.append(msg.payload)

    # Subscribe error handler to prevent unhandled errors
    s.subscribe('errors', lambda msg: None)
    s.subscribe('data', bad_consumer)
    s.subscribe('data', good_consumer)
    s.produce('data', 'test1')
    s.produce('data', 'test2')
    await asyncio.sleep(0.3)
    try:
        assert 'test1' in received, f"good_consumer should receive test1, got {received}"
        assert 'test2' in received, f"good_consumer should receive test2, got {received}"
        report("consumer error does not crash stream for other consumers", True)
    except AssertionError as e:
        report("consumer error does not crash stream for other consumers", False, str(e))


# ===========================================================================
# 5. subscribe_errors flow
# ===========================================================================

async def test_errors_topic_receives_explicitly_produced_errors():
    """Directly producing to the 'errors' topic should deliver to error subscribers."""
    s = Stream()
    error_messages = []

    def error_handler(msg: Message):
        error_messages.append(msg)

    s.subscribe('errors', error_handler)
    s.produce('errors', None, error=Exception("manual error"))
    await asyncio.sleep(0.1)
    try:
        assert len(error_messages) == 1
        assert isinstance(error_messages[0].error, Exception)
        assert str(error_messages[0].error) == "manual error"
        report("errors topic receives explicitly produced errors", True)
    except AssertionError as e:
        report("errors topic receives explicitly produced errors", False, str(e))


async def test_multiple_error_subscribers():
    """Multiple error subscribers should all receive error messages."""
    s = Stream()
    errors1 = []
    errors2 = []

    def handler1(msg: Message):
        errors1.append(msg)

    def handler2(msg: Message):
        errors2.append(msg)

    s.subscribe('errors', handler1)
    s.subscribe('errors', handler2)
    s.produce('errors', None, error=Exception("test"))
    await asyncio.sleep(0.1)
    try:
        assert len(errors1) == 1
        assert len(errors2) == 1
        report("multiple error subscribers all receive errors", True)
    except AssertionError as e:
        report("multiple error subscribers all receive errors", False, str(e))


# ===========================================================================
# 6. Close/cleanup
# ===========================================================================

async def test_close_clears_consumers():
    """After closing, consumers should no longer receive messages."""
    s = Stream()
    received = []

    def consumer(msg: Message):
        received.append(msg.payload)

    s.subscribe('t', consumer)
    s.produce('t', 'before_close')
    await asyncio.sleep(0.1)
    await s.close()
    s.produce('t', 'after_close')
    await asyncio.sleep(0.1)
    try:
        assert received == ['before_close'], f"Expected ['before_close'], got {received}"
        report("close clears consumers - no messages after close", True)
    except AssertionError as e:
        report("close clears consumers - no messages after close", False, str(e))


async def test_close_clears_message_history():
    """After closing, message history should be cleared."""
    s = Stream()
    s.produce('t', 'data')
    assert len(s.get_message_history('t')) == 1
    await s.close()
    try:
        assert len(s.get_message_history('t')) == 0, f"Expected empty history, got {s.get_message_history('t')}"
        report("close clears message history", True)
    except AssertionError as e:
        report("close clears message history", False, str(e))


async def test_close_clears_topic_indexes():
    """After closing, topic indexes should be reset."""
    s = Stream()
    s.produce('t', 'a')
    s.produce('t', 'b')
    assert s.get_last_index('t') == 1
    await s.close()
    try:
        assert s.get_last_index('t') == -1, f"Expected -1, got {s.get_last_index('t')}"
        report("close resets topic indexes", True)
    except AssertionError as e:
        report("close resets topic indexes", False, str(e))


async def test_close_cancels_async_consumer_tasks():
    """Close should cancel any pending async consumer tasks."""
    s = Stream()
    started = asyncio.Event()
    finished = False

    async def slow_consumer(msg: Message):
        nonlocal finished
        started.set()
        await asyncio.sleep(10)  # Very long - should be cancelled
        finished = True

    s.subscribe('t', slow_consumer, {'synchronous': False})
    s.produce('t', 'data')
    # Wait for the consumer to start
    await asyncio.sleep(0.1)
    await s.close()
    await asyncio.sleep(0.1)
    try:
        assert not finished, "Slow consumer should have been cancelled by close"
        report("close cancels pending async consumer tasks", True)
    except AssertionError as e:
        report("close cancels pending async consumer tasks", False, str(e))


async def test_reuse_stream_after_close():
    """After closing, the stream should be reusable (re-subscribe and produce)."""
    s = Stream()
    received = []

    def consumer(msg: Message):
        received.append(msg.payload)

    s.subscribe('t', consumer)
    s.produce('t', 'first')
    await asyncio.sleep(0.1)
    await s.close()

    # Reuse
    received2 = []

    def consumer2(msg: Message):
        received2.append(msg.payload)

    s.subscribe('t', consumer2)
    s.produce('t', 'second')
    await asyncio.sleep(0.1)
    try:
        assert received == ['first'], f"First consumer got {received}"
        assert received2 == ['second'], f"Second consumer got {received2}"
        report("stream is reusable after close", True)
    except AssertionError as e:
        report("stream is reusable after close", False, str(e))


# ===========================================================================
# 7. Edge cases and potential bugs
# ===========================================================================

def test_max_messages_per_topic_zero():
    """When max_messages_per_topic is 0, messages should not be stored but still delivered."""
    s = Stream(max_messages_per_topic=0)
    received = []

    def consumer(msg: Message):
        received.append(msg.payload)

    s.subscribe('t', consumer)
    s.produce('t', 'data')
    # Messages should not be stored
    try:
        assert len(s.get_message_history('t')) == 0, f"Expected 0 stored messages, got {len(s.get_message_history('t'))}"
        report("max_messages_per_topic=0 does not store messages", True)
    except AssertionError as e:
        report("max_messages_per_topic=0 does not store messages", False, str(e))


async def test_max_messages_per_topic_zero_still_delivers():
    """When max_messages_per_topic is 0, messages should still be delivered to consumers."""
    s = Stream(max_messages_per_topic=0)
    received = []

    def consumer(msg: Message):
        received.append(msg.payload)

    s.subscribe('t', consumer)
    s.produce('t', 'data')
    await asyncio.sleep(0.1)
    try:
        assert received == ['data'], f"Expected ['data'], got {received}"
        report("max_messages_per_topic=0 still delivers to consumers", True)
    except AssertionError as e:
        report("max_messages_per_topic=0 still delivers to consumers", False, str(e))


def test_max_messages_evicts_oldest():
    """When max_messages_per_topic is exceeded, the oldest message should be evicted."""
    s = Stream(max_messages_per_topic=3)
    s.produce('t', 'a')
    s.produce('t', 'b')
    s.produce('t', 'c')
    s.produce('t', 'd')  # Should evict 'a'
    msgs = s.get_message_history('t')
    try:
        # Note: The eviction check is `> max` not `>=`, so it evicts after 4th message
        # when len > 3 (i.e., len == 4 before append, evict one, then append -> len 4 again)
        # Actually let's just check the behavior
        payloads = [m.payload for m in msgs]
        # With max=3 and 4 produces: len check happens BEFORE append
        # After 3rd: len=3, not > 3, so no eviction, append -> len=4? No...
        # Actually: produce checks len(messages) > max BEFORE appending
        # After 1st produce: len=1, not > 3, append -> [a]
        # After 2nd produce: len=1... wait, len at check time is current length
        # Let me re-read the code...
        # After produce('a'): topics['t'] = [a], len=1
        # After produce('b'): len=1, not > 3, append -> [a,b], len=2
        # Wait no, the check is BEFORE append each time
        # produce('a'): topics['t']=[], len=0, not>3, append -> [a]
        # produce('b'): len=1, not>3, append -> [a,b]
        # produce('c'): len=2, not>3, append -> [a,b,c]
        # produce('d'): len=3, not>3, append -> [a,b,c,d]
        # So with max=3, we actually get 4 messages stored! That seems like a bug.
        # The check should be >= not >
        # Let's verify
        if len(msgs) == 4:
            report("max_messages eviction: BUG - off-by-one, stores max+1 messages", False,
                   f"max_messages_per_topic=3 but {len(msgs)} messages stored (payloads: {payloads}). Eviction uses '>' instead of '>='")
        elif len(msgs) == 3:
            assert 'a' not in payloads, f"'a' should have been evicted, got {payloads}"
            report("max_messages evicts oldest correctly", True)
        else:
            report("max_messages eviction unexpected count", False, f"Got {len(msgs)} messages: {payloads}")
    except AssertionError as e:
        report("max_messages eviction", False, str(e))


def test_message_metadata_has_stream_reference():
    """Message metadata should contain a reference back to the stream."""
    s = Stream()
    s.produce('t', 'data')
    msg = s.get_message_history('t')[0]
    try:
        assert msg.metadata.stream is s
        report("message metadata contains stream reference", True)
    except AssertionError as e:
        report("message metadata contains stream reference", False, str(e))


def test_get_message_history_empty_topic():
    """Getting message history for a non-existent topic should return empty list."""
    s = Stream()
    try:
        result = s.get_message_history('nonexistent')
        assert result == []
        report("get_message_history returns [] for nonexistent topic", True)
    except AssertionError as e:
        report("get_message_history returns [] for nonexistent topic", False, str(e))


def test_get_last_index_empty_topic():
    """Getting last index for a non-existent topic should return -1."""
    s = Stream()
    try:
        result = s.get_last_index('nonexistent')
        assert result == -1
        report("get_last_index returns -1 for nonexistent topic", True)
    except AssertionError as e:
        report("get_last_index returns -1 for nonexistent topic", False, str(e))


async def test_consumer_index_skips_old_messages():
    """Consumer should skip messages with index <= its current_index."""
    s = Stream()
    received = []

    def consumer(msg: Message):
        received.append(msg.payload)

    # Produce some messages first
    s.produce('t', 'old1')
    s.produce('t', 'old2')
    # Subscribe after - consumer's current_index will be set to last index (1)
    s.subscribe('t', consumer)
    # New messages should be received
    s.produce('t', 'new1')
    await asyncio.sleep(0.1)
    try:
        assert received == ['new1'], f"Expected ['new1'], got {received}"
        report("consumer skips messages with old indexes", True)
    except AssertionError as e:
        report("consumer skips messages with old indexes", False, str(e))


async def test_subscribe_with_params_dict():
    """subscribe() should accept a dict for params with synchronous and consumerMaxBacklogSize."""
    s = Stream()
    received = []

    def consumer(msg: Message):
        received.append(msg.payload)

    # This should not crash - passing proper dict params
    try:
        s.subscribe('t', consumer, {'synchronous': True, 'consumerMaxBacklogSize': 500})
        s.produce('t', 'test')
        await asyncio.sleep(0.1)
        assert received == ['test']
        report("subscribe with dict params works correctly", True)
    except Exception as e:
        report("subscribe with dict params works correctly", False, str(e))


async def test_subscribe_with_boolean_params_crashes():
    """The existing test_stream.py passes True as params (line 50) - this should crash since .get() is called on it."""
    s = Stream()

    def consumer(msg: Message):
        pass

    try:
        s.subscribe('t', consumer, True)  # This is what the existing test does
        report("subscribe with boolean params: BUG - should crash but didn't", False,
               "Passing True as params should raise AttributeError on .get()")
    except (AttributeError, TypeError) as e:
        report("subscribe with boolean params correctly raises error", True)
    except Exception as e:
        report("subscribe with boolean params raises unexpected error", False, str(e))


async def test_consumer_backlog_overflow():
    """When backlog exceeds max size, oldest messages should be dropped."""
    s = Stream()
    received = []

    async def slow_consumer(msg: Message):
        await asyncio.sleep(0.5)
        received.append(msg.payload)

    s.subscribe('t', slow_consumer, {'consumerMaxBacklogSize': 3})

    # Flood with messages
    for i in range(10):
        s.produce('t', f'msg_{i}')

    await asyncio.sleep(2)
    try:
        # The consumer should have processed some but dropped oldest when backlog > 3
        assert len(received) < 10, f"Expected some dropped messages, got all {len(received)}"
        report("consumer backlog overflow drops oldest messages", True)
    except AssertionError as e:
        # It's also possible all were processed if the consumer was fast enough
        report("consumer backlog overflow drops oldest messages", False, str(e))


async def test_on_error_vs_on_close_payload_inconsistency():
    """
    BUG CHECK: In exchange.py, on_error uses stream.produce('errors', 'on_error', error)
    but on_close uses self.stream_produce('errors', None, client.error).
    on_error passes the string 'on_error' as payload, while on_close passes None.
    This is an inconsistency - on_error should probably pass None or a more meaningful payload.
    """
    s = Stream()
    error_payloads = []

    def error_handler(msg: Message):
        error_payloads.append(msg.payload)

    s.subscribe('errors', error_handler)

    # Simulate what on_error does
    s.produce('errors', 'on_error', Exception("ws error"))
    # Simulate what on_close does
    s.produce('errors', None, Exception("close error"))

    await asyncio.sleep(0.1)
    try:
        # Document the inconsistency
        assert error_payloads[0] == 'on_error', f"on_error payload: {error_payloads[0]}"
        assert error_payloads[1] is None, f"on_close payload: {error_payloads[1]}"
        report("on_error vs on_close payload inconsistency: CONFIRMED BUG", False,
               "on_error passes 'on_error' string as payload, on_close passes None. "
               "Inconsistent error reporting - on_error should pass None or meaningful data.")
    except (AssertionError, IndexError) as e:
        report("on_error vs on_close payload check", False, str(e))


def test_add_watch_function():
    """add_watch_function should store the function and args."""
    s = Stream()
    s.add_watch_function('watchTrades', ['BTC/USDT', None, None, {}])
    try:
        assert len(s.active_watch_functions) == 1
        assert s.active_watch_functions[0]['method'] == 'watchTrades'
        assert s.active_watch_functions[0]['args'] == ['BTC/USDT', None, None, {}]
        report("add_watch_function stores function and args", True)
    except AssertionError as e:
        report("add_watch_function stores function and args", False, str(e))


async def test_close_clears_watch_functions():
    """After closing, active_watch_functions should be cleared."""
    s = Stream()
    s.add_watch_function('watchTrades', ['BTC/USDT'])
    assert len(s.active_watch_functions) == 1
    await s.close()
    try:
        assert len(s.active_watch_functions) == 0, f"Expected 0 watch functions, got {len(s.active_watch_functions)}"
        report("close clears active_watch_functions", True)
    except AssertionError as e:
        report("close clears active_watch_functions", False, str(e))


async def test_rapid_produce_consume_ordering():
    """Messages should be delivered in order even under rapid production."""
    s = Stream()
    received = []

    def consumer(msg: Message):
        received.append(msg.payload)

    s.subscribe('t', consumer)
    for i in range(100):
        s.produce('t', i)

    await asyncio.sleep(0.5)
    try:
        assert received == list(range(100)), f"Messages out of order. First 10: {received[:10]}, Last 10: {received[-10:]}"
        report("rapid produce maintains message ordering", True)
    except AssertionError as e:
        report("rapid produce maintains message ordering", False, str(e))


async def test_non_synchronous_consumer():
    """Consumer with synchronous=False should process messages concurrently via asyncio tasks."""
    s = Stream()
    received = []
    order = []

    async def consumer(msg: Message):
        order.append(f'start_{msg.payload}')
        await asyncio.sleep(0.05)
        received.append(msg.payload)
        order.append(f'end_{msg.payload}')

    s.subscribe('t', consumer, {'synchronous': False})
    s.produce('t', 'a')
    s.produce('t', 'b')
    await asyncio.sleep(0.3)
    try:
        assert 'a' in received and 'b' in received, f"Expected both messages, got {received}"
        report("non-synchronous consumer processes messages", True)
    except AssertionError as e:
        report("non-synchronous consumer processes messages", False, str(e))


# ===========================================================================
# Run all tests
# ===========================================================================

async def main():
    print("\n=== CCXT Python Streaming Infrastructure Tests ===\n")

    print("--- 1. Basic produce and subscribe ---")
    test_produce_creates_message()
    test_produce_with_error()
    test_produce_increments_index()
    test_produce_independent_topic_indexes()
    await test_subscribe_receives_messages()
    await test_subscribe_does_not_receive_prior_messages()
    await test_async_consumer()

    print("\n--- 2. Null/undefined payload handling ---")
    await test_none_payload()
    await test_empty_string_payload()
    await test_dict_payload()

    print("\n--- 3. Multiple subscribers ---")
    await test_multiple_subscribers_same_topic()
    await test_subscribers_different_topics()
    await test_unsubscribe()
    test_unsubscribe_nonexistent_topic()
    await test_unsubscribe_one_of_multiple()

    print("\n--- 4. Error handling in consumers ---")
    await test_consumer_error_produces_to_errors_topic()
    await test_async_consumer_error_produces_to_errors_topic()
    await test_consumer_error_does_not_crash_stream()

    print("\n--- 5. subscribe_errors flow ---")
    await test_errors_topic_receives_explicitly_produced_errors()
    await test_multiple_error_subscribers()

    print("\n--- 6. Close/cleanup ---")
    await test_close_clears_consumers()
    await test_close_clears_message_history()
    await test_close_clears_topic_indexes()
    await test_close_cancels_async_consumer_tasks()
    await test_reuse_stream_after_close()
    await test_close_clears_watch_functions()

    print("\n--- 7. Edge cases and potential bugs ---")
    test_max_messages_per_topic_zero()
    await test_max_messages_per_topic_zero_still_delivers()
    test_max_messages_evicts_oldest()
    test_message_metadata_has_stream_reference()
    test_get_message_history_empty_topic()
    test_get_last_index_empty_topic()
    await test_consumer_index_skips_old_messages()
    await test_subscribe_with_params_dict()
    await test_subscribe_with_boolean_params_crashes()
    await test_consumer_backlog_overflow()
    await test_on_error_vs_on_close_payload_inconsistency()
    test_add_watch_function()
    await test_rapid_produce_consume_ordering()
    await test_non_synchronous_consumer()

    print(f"\n=== Results: {passed} passed, {failed} failed ===")
    if errors_list:
        print("\nFailed tests:")
        for name, error in errors_list:
            print(f"  - {name}: {error}")
    print()


if __name__ == '__main__':
    asyncio.run(main())
