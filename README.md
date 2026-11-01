# Court Tracker

A personal, read-only **McCarren indoor court calendar**, running locally at **http://127.0.0.1:4317**. Other venues are deferred. The application reads CourtReserve organization `10243`; booking stays on McCarren's site.

## Start

Requirements: Node.js 24 LTS with Corepack, Docker Desktop for the container option, and your McCarren account. pnpm is pinned by the project; no global pnpm installation is needed.

From this project directory:

```sh
make install
make browser
COLLECTION_ENABLED=true make connect # Initial connection/expired login only; stored pause/cooldown still blocks it
```

In the separate Chrome for Testing window, sign in normally and open the court schedule. Switch to the **Save McCarren session** tab and click **Save session**. Enter passwords and verification codes only in the provider's browser.

Choose one runtime:

```sh
make up               # Build/start Docker in the background
# Open http://127.0.0.1:4317
make down             # Stop Docker; preserve sessions, settings, and schedule
```

Provider collection is **paused by default** while McCarren's acceptable automated cadence is unconfirmed. The local dashboard still serves its cache. After McCarren/CourtReserve confirms an acceptable read cadence, enable collection explicitly when starting the runtime:

```sh
COLLECTION_ENABLED=true make up
# or
COLLECTION_ENABLED=true make dev
```

Enabling collection starts a provider check immediately. Do not enable it just to test connectivity or bypass a known cooldown.

Or run natively:

```sh
make dev              # Build, then run the service in the foreground; Ctrl-C stops it
```

Run one calendar instance at a time. Both runtimes use the same protected `.local/` directory. Docker includes Chromium and a virtual display so the working **headed-browser** connector can run without opening desktop windows. The host-login cookies have been tested in the container. Headless provider access was blocked by Cloudflare; the default does not use it.

With the service running, open **http://127.0.0.1:4317/architecture** for the interactive, local-only system diagram. Select a flow and step through the calendar read, background collection, session setup, and refresh request.

## What the calendar shows

- Rolling seven-day week view, focused day view, individual court choices, and external booking details.
- When explicitly enabled, automatic collection checks **all eight currently posted dates** (today plus seven days ahead), with every configured time row and all seven court columns verified. The eighth date is available when navigating forward.
- Explicit native **Reserve start choices**. The site does not establish supported reservation duration, price, or eligibility through the verified schedule reads, so these remain labeled unknown. Adjacent starts are never merged into an invented booking option.
- A minimum-duration filter with an explicit choice to include starts whose duration is unknown. Unknown starts are not claimed to meet the selected duration. Uncheck that option to show only verified duration matches, which may currently be empty.
- Date-specific checked timestamps, unknown coverage, errors, and stale cached data. A failed or partial refresh never clears a previously complete date or advances its success timestamp. Empty checked schedules are distinct from unknown or failed dates.
- Saved view, duration, and court filters. The dashboard reads cached data; opening it does not scrape the provider.

When enabled, the collector checks the posted range every `REFRESH_SECONDS` (default 900; minimum 900, maximum 3600) after the previous cycle completes, independently of the dashboard tab. Closing the tab does not stop it; sleeping the computer or stopping the service does. Provider browsers close between scans to prevent idle page traffic. The local dashboard reads its cache every 15 seconds. Manual refresh respects the same cooldown and is unavailable while local collection is paused.

The earlier two-minute setting and the subsequent 15-minute setting both preceded home-network Cloudflare 429s. Fifteen minutes is **not** a provider-approved safe limit. No exact request quota or approved cadence is known. The code applies `Retry-After` but caps it at 86,400 seconds (24 hours), so a stored 24-hour deadline does not prove the provider header was exactly 24 hours. Scheduled, manual, reconnect, and CLI provider requests remain blocked during the local pause or a persisted cooldown. Standalone provider commands also fail closed without local collection status unless `COLLECTION_ENABLED=true` is explicitly supplied; this does not override a saved pause or cooldown.

**Current incident:** [McCarren rate-limit findings](docs/incidents/2026-10-31-mccarren-rate-limit.md). The latest recorded effective not-before deadline is **2026-11-02 13:55:41 UTC / 8:55:41 a.m. EST**. Collection is locally paused and will not retry automatically at that time. Cached observations remain historical until a complete verified read succeeds; a successful login alone does not establish recovery.

## Monitoring and logs

Open **Refresh activity & diagnostics** beneath the calendar to see last full success, attempts, next retry, stage/HTTP/network errors, and recent run history. It reads cached local diagnostics and never scrapes the provider.

```sh
make status                         # Source freshness, latest failure, next retry
make logs                           # Follow timestamped, redacted refresh/service events
corepack pnpm exec node scripts/status.ts --history
curl -f http://127.0.0.1:4317/health/collection
```

`make status` exits with code 2 when collection is not fresh. `/health/collection` returns HTTP 503 for degraded/stale collection. Docker's health check and `/health/ready` cover the local service/storage only; they can remain healthy while a provider is unavailable. External alert notifications are not configured.

New run records persist for seven days in SQLite and survive container recreation. Docker stdout logs are structured and rotated at 3 × 10 MB. Before this incident, only startup logs and date-check history existed; historical request-level HTTP causes cannot be reconstructed. No raw authenticated responses, request URLs, cookies, tokens, or player information are logged.

## Commands and checks

```sh
make help
make verify           # Formatting, type checks, controlled tests, production build
make test-live        # Opt-in authenticated full eight-date/full-grid collection
make probe            # Public portal inspection with no saved session
corepack pnpm audit
docker compose ps
docker compose logs --no-color

# With the app already running and fresh data:
corepack pnpm exec node scripts/checks/check-app.ts

# Docker restart/persistence acceptance check (temporarily changes then restores preferences):
corepack pnpm exec node scripts/checks/check-restart.ts
```

Do not run the standalone live collector alongside the running service; they share the provider request budget. The original two-date feasibility probe remains available as `node scripts/diagnostics/mccarren.ts test-live --days=2`, but `make test-live` now uses the complete collector.

## Project layout

```text
apps/service/src/       Backend: HTTP API, scheduler, SQLite, provider connectors
apps/web/src/           React frontend
packages/contracts/src/ Shared Zod schemas, TypeScript types, and date helpers
scripts/                Supported connect, collect, and status commands
scripts/diagnostics/    Provider inspection and the legacy feasibility probe
scripts/checks/         Opt-in browser/runtime acceptance checks
scripts/maintenance/    Manual incident-state maintenance tools
docs/                   Architecture, API, source findings, and execution history
```

This is one Node package with a root `package.json` and shared dependencies. The `apps/` and `packages/` folders are source boundaries, not separate pnpm packages. Each app owns its `src/`; shared browser-safe contracts live in `packages/contracts/`. Tests are colocated with the code they exercise.

Backend implementation lives under `apps/service/src/`, including shared session handling and provider-access/cooldown operations. Scripts call those modules to perform operator tasks. Acceptance checks can change preferences or restart Docker; maintenance tools can update local incident state, so neither runs as part of normal service startup.

## Storage and reconnecting

- Provider cookies: `.local/mccarren/session.json`. Only CourtReserve cookies are saved—no passwords, localStorage, or unrelated browser profiles.
- SQLite cache/preferences/status: `.local/schedule.sqlite`, with its WAL files. Directories are private (`0700`), files private (`0600`), and local state is excluded from Git and Docker image builds.
- The latest full standalone live report is `.local/mccarren/full-result.json`; it contains sanitized court/start observations and coverage, never raw authenticated traffic or other players' details. The older probe's reports remain separate.
- To reconnect, run `make connect` on the host. The running service notices the updated session on its next scheduled metadata check, without restarting Docker.
- To disconnect, close the helper, stop the service, and remove `.local/mccarren/session.json` locally. Revoke the session through CourtReserve if needed. Treat session files as credentials and do not share them.
- Back up `.local/` only to private storage, with the service stopped for a consistent SQLite copy. `make down` preserves it; no provider state is baked into the image.

On a failed check, cached starts remain visible with their original timestamps. After a network/API error, also check the in-page error and source status; old successful data is not evidence of current availability. Local health checks report service/storage readiness independently of provider health.

During a 429 cooldown or local collection pause, reconnects and live probes are refused before any provider request. Once the provider confirms an acceptable cadence and collection is explicitly enabled, `node scripts/diagnostics/inspect-provider.ts --http` is a bounded diagnostic read; do not run it alongside collection. `node scripts/checks/check-monitoring.ts` verifies the paused dashboard and refresh deferral using only the local service, without contacting CourtReserve; it expects the recorded rate-limit incident state rather than a healthy source.

See the [interactive diagram guide](docs/architecture-diagram.md), [architecture and code tour](docs/architecture.md), [source findings](docs/sources/mccarren.md), [API contract](docs/api.md), [execution checkpoint](docs/execution.md), and the [implementation plan](docs/implementation-plan.md) for evidence and remaining work.
