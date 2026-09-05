-- Router beta schema.
--
-- Design rule throughout: GROWING MUST NOT MEAN MIGRATING. The beta runs ~100 requests/day on one
-- VM, but every table here is shaped for the volume it will see if this works — append-only event
-- tables, time-ordered UUIDs, monthly partitions present from day one. Moving to a bigger machine,
-- or moving the event tables to ClickHouse, is a deployment change, not a schema change.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id                uuid PRIMARY KEY,
    email             citext NOT NULL UNIQUE,
    -- scrypt, salted. The opposite call from api_keys.hash below, and deliberately so: a human
    -- password is low-entropy and reused across sites, so offline guessing is a real threat; an
    -- API key is 256 CSPRNG bits, where a salt would only break the O(1) lookup.
    password_hash     text NOT NULL,
    -- Never settable from signup input. Set by SQL only.
    is_admin          boolean NOT NULL DEFAULT false,
    plan              text NOT NULL DEFAULT 'beta',
    -- Unused during the beta (no email provider yet). The column exists NOW so that switching
    -- verification on later is a behaviour change rather than a migration.
    email_verified_at timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    last_login_at     timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
    -- sha256 of the session token. Same reasoning as api_keys: the token is 256 CSPRNG bits, so
    -- the digest is a lookup key, not a password hash.
    token_hash  char(64) PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    ip          inet,
    user_agent  text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------------------------
-- API keys — the projection source for the router's in-memory snapshot
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_keys (
    -- uuid, not the old k_<8 hex>. That was 32 bits, generated with NO collision check anywhere,
    -- and freed for reuse on delete — which merges two customers' usage into one invoice line.
    id                 uuid PRIMARY KEY,
    -- What appears in logs, support tickets and invoices. Stable, human-quotable, never reused.
    display_id         text NOT NULL UNIQUE,
    user_id            uuid NOT NULL REFERENCES users(id),
    name               text NOT NULL,
    -- Unsalted sha256 of the plaintext key. Unsalted is required, not lazy: it is what makes the
    -- router's lookup one digest and one Map.get, constant-time by construction and flat in key
    -- count. A salt would force an O(N) scan that leaks which key matched.
    hash               char(64) NOT NULL UNIQUE,
    last4              char(4) NOT NULL,
    note               text NOT NULL DEFAULT '',
    -- Ceilings, not just defaults. A key minted with 1e9 is an outage lever aimed at the process
    -- whose restart costs minutes of degraded routing, so the bound lives in the schema where the
    -- dashboard, the API and a hand-written INSERT are all subject to it.
    rate_limit_max     integer CHECK (rate_limit_max IS NULL OR (rate_limit_max > 0 AND rate_limit_max <= 10000)),
    ws_max_connections integer CHECK (ws_max_connections IS NULL OR (ws_max_connections > 0 AND ws_max_connections <= 100)),
    created_at         timestamptz NOT NULL DEFAULT now(),
    created_by         text NOT NULL DEFAULT 'self-serve',
    revoked_at         timestamptz,
    UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);
-- The router's refresh query: every key that still authenticates.
CREATE INDEX IF NOT EXISTS api_keys_active_idx ON api_keys (revoked_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Request records
-- ---------------------------------------------------------------------------------------------
-- Partitioned from day one even though one partition is plenty at beta volume, because adding
-- retention later then means DROP TABLE on a partition rather than a multi-million-row DELETE.
-- Retention during the beta is FOREVER: ~100 req/day is ~36,500 rows/year.

CREATE TABLE IF NOT EXISTS requests (
    id               uuid        NOT NULL,
    ts               timestamptz NOT NULL,
    -- NULL for unauthenticated requests. Those are recorded too: a 401 is exactly the traffic you
    -- want to see when something is wrong, and dropping it would hide abuse.
    key_id           uuid,
    user_id          uuid,
    route            text        NOT NULL,   -- route TEMPLATE, never the raw URL (cardinality)
    method           text        NOT NULL,
    status           smallint    NOT NULL,
    duration_ms      real        NOT NULL,

    -- What was asked for
    from_asset       text,
    to_asset         text,
    exact_side       text,
    requested_amount numeric,
    strategy         text,

    -- What was answered
    amount_in        numeric,
    amount_out       numeric,
    effective_rate   numeric,
    reference_rate   numeric,
    impact_bps       real,
    fill_ratio       real,
    fully_fillable   boolean,
    unroutable_reason text,
    hop_count        smallint,

    -- Caller metadata. Three named fields, NEVER a loop over request.headers — x-api-key and
    -- authorization are headers, and a blanket capture would put live credentials in the database
    -- and in every backup. `ip` is personal data under GDPR; user_id is denormalised onto this row
    -- so erasure is one statement.
    ip               inet,
    user_agent       text,
    origin           text,

    -- Caller-supplied and therefore UNTRUSTED. Stored only as a join key to the log line. It must
    -- never be a uniqueness or idempotency key: a caller pinning it to a constant would collapse
    -- every request into one row and get unlimited free calls.
    request_id       text,

    PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);

CREATE INDEX IF NOT EXISTS requests_key_ts_idx  ON requests (key_id, ts DESC);
CREATE INDEX IF NOT EXISTS requests_user_ts_idx ON requests (user_id, ts DESC);

-- A route is not flat, so its arrays get child tables rather than jsonb: the questions worth
-- asking are relational ("which venues do we route to most, and for how much volume?", "how often
-- does a bridge beat the direct market?") and those are GROUP BY on columns. At ~1-2 hops and 2-6
-- legs per request the row multiplication is irrelevant, and this is exactly the shape ClickHouse
-- wants if the event tables ever move.
CREATE TABLE IF NOT EXISTS request_hops (
    request_id      uuid        NOT NULL,
    ts              timestamptz NOT NULL,
    hop_index       smallint    NOT NULL,
    pair            text        NOT NULL,
    side            text        NOT NULL,
    base            text,
    quote           text,
    amount_in       numeric,
    amount_out      numeric,
    fee_cost        numeric,
    fee_currency    text,
    reference_price numeric,
    impact_bps      real,
    fully_fillable  boolean,
    venue_count     smallint,
    fresh_venue_count smallint,
    PRIMARY KEY (ts, request_id, hop_index)
) PARTITION BY RANGE (ts);

CREATE TABLE IF NOT EXISTS request_legs (
    request_id     uuid        NOT NULL,
    ts             timestamptz NOT NULL,
    hop_index      smallint    NOT NULL,
    exchange_id    text        NOT NULL,
    amount         numeric,
    average_price  numeric,
    taker_fee_rate numeric,
    fee_cost       numeric,
    PRIMARY KEY (ts, request_id, hop_index, exchange_id)
) PARTITION BY RANGE (ts);

CREATE INDEX IF NOT EXISTS request_legs_exchange_idx ON request_legs (exchange_id, ts DESC);

-- ---------------------------------------------------------------------------------------------
-- Rollups
-- ---------------------------------------------------------------------------------------------
-- At beta volume the dashboard could read `requests` directly. This exists so that the query the
-- dashboard runs is the SAME query at 100 req/day and at 1,000 req/s — changing that query later
-- is the migration this table avoids.

CREATE TABLE IF NOT EXISTS usage_hour (
    hour_start   timestamptz NOT NULL,
    key_id       uuid        NOT NULL,
    user_id      uuid        NOT NULL,
    route        text        NOT NULL,
    status_class smallint    NOT NULL,      -- 2, 4, 5 — not the exact code
    requests     bigint      NOT NULL,
    duration_sum double precision NOT NULL,
    PRIMARY KEY (hour_start, key_id, route, status_class)
);
CREATE INDEX IF NOT EXISTS usage_hour_user_idx ON usage_hour (user_id, hour_start DESC);

-- ---------------------------------------------------------------------------------------------
-- Ingest cursor
-- ---------------------------------------------------------------------------------------------
-- There is deliberately no second database. The durable buffer is the audit log file, which is
-- already durable; this cursor is committed in the SAME transaction as the rows it accounts for,
-- which is what makes replay idempotent after a crash or a Postgres restart.

CREATE TABLE IF NOT EXISTS ingest_cursor (
    stream      text PRIMARY KEY,
    byte_offset bigint NOT NULL,
    inode       bigint,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- Admin audit
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_audit (
    id         bigserial PRIMARY KEY,
    ts         timestamptz NOT NULL DEFAULT now(),
    actor_user_id uuid REFERENCES users(id),
    action     text NOT NULL,
    subject    text,
    detail     jsonb,
    ip         inet
);
CREATE INDEX IF NOT EXISTS admin_audit_ts_idx ON admin_audit (ts DESC);
