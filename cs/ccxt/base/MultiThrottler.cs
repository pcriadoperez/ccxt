using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Linq;

namespace ccxt
{
    /// <summary>
    /// Represents a single rate limiting rule
    /// </summary>
    public class ThrottleRule
    {
        public string Id { get; set; }                     // Unique identifier for the rule
        public double Capacity { get; set; }               // Maximum tokens this rule can hold
        public double RefillRate { get; set; }             // Rate at which tokens are refilled (tokens per millisecond)
        public double Tokens { get; set; }                 // Current available tokens
        public string IntervalType { get; set; }           // For documentation/debugging ('SECOND', 'MINUTE', 'HOUR', 'DAY')
        public int IntervalNum { get; set; }               // Number of intervals

        public ThrottleRule(string id, double capacity, double refillRate, double tokens, string intervalType, int intervalNum)
        {
            Id = id;
            Capacity = capacity;
            RefillRate = refillRate;
            Tokens = tokens;
            IntervalType = intervalType;
            IntervalNum = intervalNum;
        }

        // Clone constructor
        public ThrottleRule(ThrottleRule other)
        {
            Id = other.Id;
            Capacity = other.Capacity;
            RefillRate = other.RefillRate;
            Tokens = other.Tokens;
            IntervalType = other.IntervalType;
            IntervalNum = other.IntervalNum;
        }
    }

    /// <summary>
    /// Configuration options for the MultiThrottler
    /// </summary>
    public class MultiThrottlerConfig
    {
        public int MaxCapacity { get; set; } = 2000;       // Maximum queue size before throwing errors
        public double Delay { get; set; } = 0.001;         // Sleep delay between checks (in seconds)

        public MultiThrottlerConfig() { }

        public MultiThrottlerConfig(int maxCapacity, double delay)
        {
            MaxCapacity = maxCapacity;
            Delay = delay;
        }
    }

    /// <summary>
    /// Queue item representing a pending request
    /// </summary>
    internal class QueueItem
    {
        public TaskCompletionSource<object> TaskCompletionSource { get; set; }
        public Dictionary<string, double> Cost { get; set; }
        public long Timestamp { get; set; }

        public QueueItem(TaskCompletionSource<object> taskCompletionSource, Dictionary<string, double> cost, long timestamp)
        {
            TaskCompletionSource = taskCompletionSource;
            Cost = cost;
            Timestamp = timestamp;
        }
    }

    /// <summary>
    /// Multi-rule throttler that can enforce multiple rate limiting rules simultaneously.
    /// Supports Binance-style rate limiting with different rule types (REQUEST_WEIGHT, RAW_REQUESTS, ORDERS, etc.)
    /// </summary>
    public class MultiThrottler
    {
        private readonly Dictionary<string, ThrottleRule> _rules;
        private readonly MultiThrottlerConfig _config;
        private readonly Queue<QueueItem> _queue;
        private bool _running;
        private readonly object _lock = new object();

        public MultiThrottler(List<ThrottleRule> rules, MultiThrottlerConfig config = null)
        {
            _rules = new Dictionary<string, ThrottleRule>();
            
            // Initialize rules map
            foreach (var rule in rules)
            {
                // Clone rule to avoid mutations
                _rules[rule.Id] = new ThrottleRule(rule);
            }

            _config = config ?? new MultiThrottlerConfig();
            _queue = new Queue<QueueItem>();
            _running = false;
        }

        /// <summary>
        /// Add or update a throttling rule
        /// </summary>
        public void AddRule(ThrottleRule rule)
        {
            lock (_lock)
            {
                _rules[rule.Id] = new ThrottleRule(rule);
            }
        }

        /// <summary>
        /// Remove a throttling rule
        /// </summary>
        public bool RemoveRule(string ruleId)
        {
            lock (_lock)
            {
                return _rules.Remove(ruleId);
            }
        }

        /// <summary>
        /// Get current status of all rules
        /// </summary>
        public Dictionary<string, Dictionary<string, double>> GetStatus()
        {
            var status = new Dictionary<string, Dictionary<string, double>>();
            
            lock (_lock)
            {
                foreach (var kvp in _rules)
                {
                    var rule = kvp.Value;
                    status[kvp.Key] = new Dictionary<string, double>
                    {
                        ["tokens"] = rule.Tokens,
                        ["capacity"] = rule.Capacity,
                        ["utilization"] = 1 - (rule.Tokens / rule.Capacity)
                    };
                }
            }
            
            return status;
        }

        /// <summary>
        /// Check if a request can be processed immediately (all rules have sufficient tokens)
        /// </summary>
        private bool CanProcess(Dictionary<string, double> cost)
        {
            foreach (var kvp in cost)
            {
                if (!_rules.TryGetValue(kvp.Key, out var rule))
                {
                    throw new ArgumentException($"Unknown throttle rule: {kvp.Key}");
                }
                
                if (rule.Tokens < kvp.Value)
                {
                    return false;
                }
            }
            return true;
        }

        /// <summary>
        /// Consume tokens from all applicable rules
        /// </summary>
        private void ConsumeTokens(Dictionary<string, double> cost)
        {
            foreach (var kvp in cost)
            {
                if (_rules.TryGetValue(kvp.Key, out var rule))
                {
                    rule.Tokens -= kvp.Value;
                }
            }
        }

        /// <summary>
        /// Refill tokens for all rules based on elapsed time
        /// </summary>
        private void RefillTokens(double elapsed)
        {
            foreach (var rule in _rules.Values)
            {
                var tokensToAdd = rule.RefillRate * elapsed;
                rule.Tokens = Math.Min(rule.Tokens + tokensToAdd, rule.Capacity);
            }
        }

        /// <summary>
        /// Calculate the minimum time needed for a request to be processable
        /// </summary>
        private double CalculateWaitTime(Dictionary<string, double> cost)
        {
            double maxWaitTime = 0.0;

            foreach (var kvp in cost)
            {
                if (!_rules.TryGetValue(kvp.Key, out var rule))
                    continue;

                if (rule.Tokens < kvp.Value)
                {
                    var tokensNeeded = kvp.Value - rule.Tokens;
                    var waitTime = tokensNeeded / rule.RefillRate;
                    maxWaitTime = Math.Max(maxWaitTime, waitTime);
                }
            }

            return maxWaitTime;
        }

        /// <summary>
        /// Main processing loop
        /// </summary>
        private async Task Loop()
        {
            long lastTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            while (_running)
            {
                QueueItem item = null;
                
                lock (_lock)
                {
                    if (_queue.Count == 0)
                    {
                        _running = false;
                        return;
                    }
                }

                long currentTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                double elapsed = currentTime - lastTimestamp;
                lastTimestamp = currentTime;

                lock (_lock)
                {
                    // Refill tokens for all rules
                    RefillTokens(elapsed);

                    // Process as many items from the queue as possible
                    int processed = 0;
                    while (_queue.Count > 0)
                    {
                        item = _queue.Peek();
                        
                        if (CanProcess(item.Cost))
                        {
                            ConsumeTokens(item.Cost);
                            _queue.Dequeue();
                            
                            // Complete the task outside the lock
                            Task.Run(() => item.TaskCompletionSource.SetResult(null));
                            
                            processed++;
                            
                            // Allow other operations to run
                            if (processed % 10 == 0)
                            {
                                break;
                            }
                        }
                        else
                        {
                            // Can't process this item yet, break and wait
                            break;
                        }
                    }

                    // If no items were processed, calculate wait time
                    if (processed == 0 && _queue.Count > 0)
                    {
                        item = _queue.Peek();
                    }
                    else
                    {
                        item = null;
                    }
                }

                if (item != null)
                {
                    var waitTime = CalculateWaitTime(item.Cost);
                    var sleepTime = Math.Min(waitTime, _config.Delay * 1000);
                    await Task.Delay(TimeSpan.FromMilliseconds(sleepTime));
                }
                else
                {
                    // Small delay to prevent tight loop
                    await Task.Delay(1);
                }
            }
        }

        /// <summary>
        /// Submit a request to be throttled according to the defined rules
        /// </summary>
        /// <param name="cost">Dictionary mapping rule IDs to their costs for this request</param>
        /// <returns>Task that completes when the request can proceed</returns>
        public async Task Throttle(Dictionary<string, double> cost)
        {
            // Validate that all cost rules exist
            foreach (var ruleId in cost.Keys)
            {
                if (!_rules.ContainsKey(ruleId))
                {
                    var availableRules = string.Join(", ", _rules.Keys);
                    throw new ArgumentException($"Unknown throttle rule: {ruleId}. Available rules: {availableRules}");
                }
            }

            TaskCompletionSource<object> taskCompletionSource;
            
            lock (_lock)
            {
                // Check queue capacity
                if (_queue.Count >= _config.MaxCapacity)
                {
                    throw new InvalidOperationException($"Throttle queue is over maxCapacity ({_config.MaxCapacity}), see https://github.com/ccxt/ccxt/issues/11645#issuecomment-1195695526");
                }

                // Create task completion source for this request
                taskCompletionSource = new TaskCompletionSource<object>();

                // Add to queue
                var item = new QueueItem(
                    taskCompletionSource,
                    cost,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                );
                _queue.Enqueue(item);

                // Start processing loop if not already running
                if (!_running)
                {
                    _running = true;
                    Task.Run(Loop); // Don't await here to allow immediate return
                }
            }

            await taskCompletionSource.Task;
        }

        /// <summary>
        /// Get the current queue length
        /// </summary>
        public int GetQueueLength()
        {
            lock (_lock)
            {
                return _queue.Count;
            }
        }

        /// <summary>
        /// Check if the throttler is currently running
        /// </summary>
        public bool IsRunning()
        {
            lock (_lock)
            {
                return _running;
            }
        }

        /// <summary>
        /// Reset all token buckets to their capacity
        /// </summary>
        public void Reset()
        {
            lock (_lock)
            {
                foreach (var rule in _rules.Values)
                {
                    rule.Tokens = rule.Capacity;
                }
            }
        }

        /// <summary>
        /// Manually set tokens for a specific rule (useful for testing)
        /// </summary>
        public void SetTokens(string ruleId, double tokens)
        {
            lock (_lock)
            {
                if (_rules.TryGetValue(ruleId, out var rule))
                {
                    rule.Tokens = Math.Max(0, Math.Min(tokens, rule.Capacity));
                }
            }
        }
    }
}