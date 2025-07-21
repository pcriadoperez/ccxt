using System.Globalization;
using System.Collections.Concurrent;

namespace ccxt;

using dict = Dictionary<string, object>;

// Individual throttle rule
public class ThrottleRule
{
    public string Id { get; set; }
    public double Capacity { get; set; }
    public double RefillRate { get; set; }
    public double Tokens { get; set; }
    public string IntervalType { get; set; }
    public int IntervalNum { get; set; }
    public string Description { get; set; }

    public ThrottleRule(string id, double capacity, double refillRate, double tokens, 
                       string intervalType = null, int intervalNum = 1, string description = null)
    {
        Id = id;
        Capacity = capacity;
        RefillRate = refillRate;
        Tokens = tokens;
        IntervalType = intervalType;
        IntervalNum = intervalNum;
        Description = description;
    }
}

// Enhanced throttler supporting multiple concurrent rate limits
public class Throttler
{
    private readonly ConcurrentDictionary<string, ThrottleRule> rules = new ConcurrentDictionary<string, ThrottleRule>();
    private readonly Queue<(TaskCompletionSource<bool>, object)> queue = new Queue<(TaskCompletionSource<bool>, object)>();
    private readonly ConcurrentDictionary<string, long> lastTimestamps = new ConcurrentDictionary<string, long>();
    private readonly object queueLock = new object();
    private bool running = false;
    private dict config; // Legacy config for backward compatibility

    // Multi-rule initialization
    public Throttler(ThrottleRule[] rules)
    {
        foreach (var rule in rules)
        {
            this.rules.TryAdd(rule.Id, rule);
            this.lastTimestamps.TryAdd(rule.Id, milliseconds());
        }
        this.config = null;
    }

    // Legacy single-rule initialization
    public Throttler(dict config)
    {
        this.config = new Dictionary<string, object>()
        {
            {"refillRate", 1.0},
            {"delay", 0.001},
            {"cost", 1.0},
            {"tokens", 0},
            {"maxCapacity", 2000},
            {"capacity", 1.0},
        };
        this.config = extend(this.config, config);

        // Create a default rule for backward compatibility
        var defaultRule = new ThrottleRule(
            "default",
            Convert.ToDouble(this.config["capacity"]),
            Convert.ToDouble(this.config["refillRate"]),
            Convert.ToDouble(this.config["tokens"])
        );
        this.rules.TryAdd("default", defaultRule);
        this.lastTimestamps.TryAdd("default", milliseconds());
    }

    private void RefillTokens()
    {
        var currentTime = milliseconds();
        
        foreach (var kvp in rules)
        {
            var ruleId = kvp.Key;
            var rule = kvp.Value;
            var lastTimestamp = lastTimestamps.GetValueOrDefault(ruleId, currentTime);
            var elapsed = currentTime - lastTimestamp;
            var tokensToAdd = rule.RefillRate * elapsed;
            rule.Tokens = Math.Min(rule.Capacity, rule.Tokens + tokensToAdd);
            lastTimestamps.TryUpdate(ruleId, currentTime, lastTimestamp);
        }
        
        // Update legacy config for backward compatibility
        if (config != null && rules.TryGetValue("default", out var defaultRule))
        {
            config["tokens"] = defaultRule.Tokens;
        }
    }

    private bool CanConsume(object cost)
    {
        if (cost is double doubleCost)
        {
            // Legacy single cost
            if (rules.TryGetValue("default", out var defaultRule))
            {
                return defaultRule.Tokens >= doubleCost;
            }
            return false;
        }
        
        if (cost is dict multiCost)
        {
            // Multi-rule cost - check all rules
            foreach (var kvp in multiCost)
            {
                var ruleId = kvp.Key;
                var ruleCost = Convert.ToDouble(kvp.Value);
                if (!rules.TryGetValue(ruleId, out var rule) || rule.Tokens < ruleCost)
                {
                    return false;
                }
            }
            return true;
        }
        
        return false;
    }

    private void Consume(object cost)
    {
        if (cost is double doubleCost)
        {
            // Legacy single cost
            if (rules.TryGetValue("default", out var defaultRule))
            {
                defaultRule.Tokens -= doubleCost;
                if (config != null)
                {
                    config["tokens"] = defaultRule.Tokens;
                }
            }
        }
        else if (cost is dict multiCost)
        {
            // Multi-rule cost
            foreach (var kvp in multiCost)
            {
                var ruleId = kvp.Key;
                var ruleCost = Convert.ToDouble(kvp.Value);
                if (rules.TryGetValue(ruleId, out var rule))
                {
                    rule.Tokens -= ruleCost;
                }
            }
        }
    }

    private async Task loop()
    {
        while (running)
        {
            lock (queueLock)
            {
                if (queue.Count == 0)
                {
                    running = false;
                    return;
                }
            }
            
            RefillTokens();
            
            lock (queueLock)
            {
                if (queue.Count > 0)
                {
                    var first = queue.Peek();
                    var taskCompletionSource = first.Item1;
                    var cost = first.Item2;
                    
                    if (CanConsume(cost))
                    {
                        Consume(cost);
                        queue.Dequeue();
                        taskCompletionSource.SetResult(true);
                        // Context switch
                        await Task.Delay(0);
                        continue;
                    }
                }
            }
            
            // Wait before checking again
            var delay = config != null ? (double)config["delay"] : 0.001;
            await Task.Delay((int)(delay * 1000));
        }
    }

    public async Task throttle(object cost = null)
    {
        var taskCompletionSource = new TaskCompletionSource<bool>();
        
        // Handle undefined cost
        if (cost == null)
        {
            if (config != null)
            {
                cost = Convert.ToDouble(config["cost"]);
            }
            else
            {
                // Default multi-rule cost
                cost = new dict { { "default", 1.0 } };
            }
        }
        
        var maxCapacity = config != null ? (int)config["maxCapacity"] : 2000;
        lock (queueLock)
        {
            if (queue.Count > maxCapacity)
            {
                throw new Exception($"throttle queue is over maxCapacity ({maxCapacity}), see https://github.com/ccxt/ccxt/issues/11645#issuecomment-1195695526");
            }
            
            queue.Enqueue((taskCompletionSource, cost));
        }
        
        if (!running)
        {
            running = true;
            _ = Task.Run(loop);
        }
        
        await taskCompletionSource.Task;
    }

    // Get current status of all rules
    public dict GetStatus()
    {
        RefillTokens();
        
        var status = new dict();
        foreach (var kvp in rules)
        {
            var ruleId = kvp.Key;
            var rule = kvp.Value;
            status[ruleId] = new dict
            {
                ["tokens"] = rule.Tokens,
                ["capacity"] = rule.Capacity,
                ["utilization"] = 1.0 - (rule.Tokens / rule.Capacity)
            };
        }
        return status;
    }

    // Set tokens for a specific rule (useful for updating from API response headers)
    public void SetTokens(string ruleId, double tokens)
    {
        if (rules.TryGetValue(ruleId, out var rule))
        {
            rule.Tokens = Math.Max(0, Math.Min(rule.Capacity, tokens));
            lastTimestamps.TryUpdate(ruleId, milliseconds(), lastTimestamps[ruleId]);
            
            // Update legacy config if this is the default rule
            if (ruleId == "default" && config != null)
            {
                config["tokens"] = rule.Tokens;
            }
        }
    }

    // Get specific rule
    public ThrottleRule GetRule(string ruleId)
    {
        rules.TryGetValue(ruleId, out var rule);
        return rule;
    }

    // Check if this is a multi-rule throttler
    public bool IsMultiRule()
    {
        return rules.Count > 1 || (rules.Count == 1 && !rules.ContainsKey("default"));
    }

    // move this elsewhere later
    private dict extend(object aa, object bb)
    {

        var a = (dict)aa;
        var b = (dict)bb;
        var keys = new List<string>(b.Keys);
        foreach (string key in keys)
        {
            a[(string)key] = b[key];
        }
        return a;
    }

    public long milliseconds()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        long unixTimeMilliseconds = now.ToUnixTimeMilliseconds();
        return unixTimeMilliseconds;
    }

}
