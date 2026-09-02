// The prompt printed by `ccxt-migrate prompt`. Kept in one place so the CLI,
// the wiki article and .claude/skills/ccxt-migrate/SKILL.md never drift apart.

export const AGENT_PROMPT = `Migrate this project from pmxt to CCXT.

Read the migration guide at https://github.com/ccxt/ccxt/blob/master/wiki/Migrate-From-PMXT.md
(also published on docs.ccxt.com) as the source of truth for the migration, and load the \`ccxt-migrate\` skill if your tooling supports skills
(\`npx skills add ccxt/ccxt\`, or \`curl -fsSL https://raw.githubusercontent.com/ccxt/ccxt/master/install-skills.sh | bash\`).
Also load the language skill for this codebase — \`ccxt-typescript\` or \`ccxt-python\`.
For anything about the pmxt side — what a method returns, what a venue class
supports — read pmxt's own docs rather than inferring it from the call site:
https://github.com/pmxt-dev/pmxt#readme and https://www.pmxt.dev/docs.

Start by running the codemod for the mechanical half:

    npx ccxt-migrate@latest --report MIGRATION-REPORT.md

Read MIGRATION-REPORT.md before you touch anything else. Its "Not migrated"
section is the part that matters: pmxt is a prediction-market aggregator and
CCXT is a spot/derivatives library, so any Polymarket, Kalshi, Limitless or
similar venue in this codebase has no CCXT equivalent at all. Do not invent
one, do not silently swap in an unrelated exchange, and do not delete the
feature. Tell me which call sites are affected and stop for a decision on them.

Then work through every \`TODO(ccxt-migrate)\` marker the codemod left:

- Replace pmxt \`outcomeId\` / \`market_id\` values with unified CCXT symbols.
  Call \`loadMarkets()\` once and look at the real keys — never guess a symbol.
- Rewrite response handling for CCXT's shapes: order-book levels are
  \`[price, amount]\` arrays, OHLCV rows are \`[timestamp, open, high, low, close, volume]\`
  arrays, and \`fetchBalance()\` returns a dict keyed by currency code with
  free/used/total.
- Convert any pmxt callback-style \`watch*\` subscription into CCXT Pro's
  await-in-a-loop pattern, and make sure \`close()\` is called on shutdown.
- Remove the pmxt hosted-session plumbing (\`pmxtApiKey\`, \`getAuthNonce\`,
  \`loginWithSignature\`, \`logout\`). CCXT talks to the venue directly and signs
  every request from the credentials on the exchange instance.
- Swap the dependency: remove \`pmxtjs\`/\`pmxt\`, add \`ccxt\`.

Explain the plan in plain language before making broad changes. Follow the
documented mapping and keep moving unless a change is destructive, credentials
are missing, or the correct migration is genuinely ambiguous — then ask me.

Then review the whole diff adversarially, assuming a regression is in there.
Every touched call site can now do something different and still compile. pmxt
called its hosted API and CCXT calls the venue directly, so the literal requests
will differ — what must match is the intent of each call: same instrument, same
time window, same limit, same order side/amount/price, same account. Check
specifically for: \`fetchOHLCV\`'s \`since\`/\`limit\` swap and a dropped \`end\`;
price scale (pmxt prices are 0–1 probabilities, so every threshold, spread check
and position-size calculation downstream is suspect); array-vs-object response
shapes failing silently; \`createOrder\` positional slots and amount units;
options the codemod reported as dropped; error classes whose hierarchy changed;
and \`fetchBalance\`/\`fetchPositions\` call sites that used to take a per-address
argument and now always return the same account. Set \`exchange.verbose = true\`
and read what actually goes out on the wire rather than reasoning about it. If
the project has tests, they should pass unchanged — a test you edited to make
green is a behaviour change, and you need to tell me about it.

Verify before you claim it works: type-check or lint the project, run its tests,
then smoke-test against a live *public* endpoint (\`fetchTicker\`, \`fetchOrderBook\`)
with no API keys involved. Never place a live order to verify a migration.

Finish with a summary of what changed, what you verified, every regression the
review turned up and how you resolved it, and every call site that still has no
CCXT equivalent.
`;
