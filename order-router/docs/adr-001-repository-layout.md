# ADR-001 — the service stays in the ccxt monorepo, isolated by folder

Status: accepted, 2026-09-02. Supersedes the "move it to its own repository" recommendation in
the beta-gate review.

## Context

A review argued for extracting `order-router/` into a separate repository. Its evidence was real:
the directory pins `ccxt` from npm rather than the workspace, carries its own `package.json`,
lockfile, `tsconfig.json` and CI workflow, and its README says it sits outside the transpile
pipeline. The concrete cost it named was that a change confined to the service scheduled the full
six-language ccxt build-and-test matrix — six pipelines of tens of minutes for one service unit
test.

## Decision

The service stays in this repository, in `order-router/`, self-contained.

The costs the review attributed to co-location were not inherent to it. They came from CI
configuration that treated the directory as part of the library, and that is fixable in the
configuration:

- The six language workflows now `paths-ignore` `order-router/**` and its workflow file. A commit
  confined to the service schedules no language build. A commit touching both still runs
  everything, because `paths-ignore` skips only when every changed path matches — which is the
  behaviour that matters.
- `build/utils/check_modified_files.sh` strips `order-router/` paths before the critical-pattern
  check. The shared arm is an unanchored `test`, which matched
  `order-router/src/api/server.test.ts`. This covers the mixed commit the workflow filters
  deliberately do not skip.

## What lives where, and why the split is not where it looks

Two different things carry the name OrderRouter, and only one of them is the service:

| | what | where | ships as |
|---|---|---|---|
| The service | holds live books, answers `/route` | `order-router/` | a deployed process |
| The client | calls that service, plans and executes | `ts/src/base/OrderRouter.ts` and its Python, PHP, C# and Go ports, plus `examples/` | part of the ccxt package |

The client belongs in ccxt whatever happens to the service — it is a public class in five
languages with a shared fixture suite, and extracting it would mean publishing a second package
for one class. The root `package.json`'s `test-order-router-*` scripts drive the CLIENT suites and
correctly stay wired into `test-base-rest-*`; a change to any of those five files SHOULD run the
full matrix, and after the filters above it still does.

## Consequences

- The service consumes the published `ccxt` package (currently `4.5.64`), not the workspace. That
  is deliberate: it makes the dependency explicit and versioned, and it is what lets the directory
  be isolated in CI at all. It also means a fix landing in `ts/src/` reaches the service only when
  the pin moves.
- Verified, not assumed: no file under `order-router/src` imports anything outside the directory.
- One thing extraction WOULD have forced that co-location does not: an owner for the production
  deploy. That remains open and is not solved by this decision — see the deployment section of the
  review.
- The upstream ccxt.pro defect the service works around locally (sockets orphaned on error) should
  still be fixed once, upstream, in `ts/src/base/ws/`, so every user benefits rather than this
  service alone.
