// The prompt printed by `ccxt-migrate prompt`. Kept in one place so the CLI,
// the wiki article and .claude/skills/ccxt-migrate/SKILL.md never drift apart.

export const AGENT_PROMPT = `Migrate this project from pmxt to CCXT.

Read the migration guide at https://github.com/ccxt/ccxt/blob/master/wiki/Migrate-From-PMXT.md
(also published on docs.ccxt.com) as the source of truth for the migration, and load the \`ccxt-migrate\` skill if your tooling supports skills
(\`npx skills add ccxt/ccxt\`, or \`curl -fsSL https://raw.githubusercontent.com/ccxt/ccxt/master/install-skills.sh | bash\`).
Also load the language skill for this codebase — \`ccxt-typescript\` or \`ccxt-python\`.

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

Verify before you claim it works: type-check or lint the project, run its tests,
then smoke-test against a live *public* endpoint (\`fetchTicker\`, \`fetchOrderBook\`)
with no API keys involved. Never place a live order to verify a migration.

Finish with a summary of what changed, what you verified, and every call site
that still has no CCXT equivalent.
`;
