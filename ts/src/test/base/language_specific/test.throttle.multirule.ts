// @ts-nocheck
/* eslint-disable */
import { Throttler } from '../../../base/functions/throttle.js'

function testThrottleMultiRule () {
    const delta = 15

    const testCases = [
        {
            name: 'two-rules-same-cost-slowest-dominates',
            rules: [
                { id: 'default', tokens: 0, refillRate: 1 / 50, cost: 1, capacity: 1 },
                { id: 'orders', tokens: 0, refillRate: 1 / 80, cost: 1, capacity: 1 },
            ],
            runs: 40,
            cost: { default: 1, orders: 1 },
        },
        {
            name: 'two-rules-different-costs',
            rules: [
                { id: 'default', tokens: 0, refillRate: 1 / 30, cost: 1, capacity: 1 },
                { id: 'weight', tokens: 0, refillRate: 1 / 60, cost: 2, capacity: 1 },
            ],
            runs: 25,
            cost: { default: 1, weight: 2 },
        },
        {
            name: 'number-cost-applies-to-all-when-no-default',
            rules: [
                { id: 'ip', tokens: 0, refillRate: 1 / 40, cost: 1, capacity: 1 },
                { id: 'uid', tokens: 0, refillRate: 1 / 70, cost: 1, capacity: 1 },
            ],
            runs: 30,
            cost: 1,
        },
    ]

    function expectedMs (test) {
        // initial run happens immediately, then bottleneck per-run time is max(cost_i / refillRate_i)
        const perRuleTimes = []
        for (const rule of test.rules) {
            let c = 0
            if (typeof test.cost === 'number') {
                c = test.cost
            } else if (typeof test.cost === 'object') {
                c = (test.cost[rule.id] !== undefined) ? test.cost[rule.id] : 0
            }
            if (c > 0) {
                perRuleTimes.push(c / rule.refillRate)
            }
        }
        const perRun = perRuleTimes.length ? Math.max(...perRuleTimes) : 0
        const runsAfterFirst = Math.max(0, test.runs - 1)
        return runsAfterFirst * perRun
    }

    async function runner (test) {
        const throttler = new Throttler({
            rules: test.rules,
            delay: 0.001,
            maxCapacity: 2000,
        })
        const start = performance.now()
        for (let i = 0; i < test.runs; i++) {
            await throttler.throttle(test.cost)
        }
        const end = performance.now()
        const elapsed = end - start
        const expected = expectedMs(test)
        const ok = Math.abs(elapsed - expected) < delta
        console.log(`multi ${test.name} ${ok ? 'succeeded' : 'failed'} in ${elapsed}ms expected ${expected}ms`)
    }

    for (const test of testCases) {
        runner(test)
    }
}

export default testThrottleMultiRule

