using System.Threading.Tasks;

namespace ccxt
{
    /// <summary>
    /// Interface for custom throttler implementations
    /// </summary>
    public interface ICustomThrottler
    {
        /// <summary>
        /// Throttle the request based on the cost
        /// </summary>
        /// <param name="cost">The cost of the request (optional)</param>
        /// <returns>A task that completes when throttling is done</returns>
        Task Throttle(object cost = null);
    }
}