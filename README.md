# Court Tracker

A personal, read-only **McCarren indoor court calendar**, running locally at **http://127.0.0.1:4317**. Other venues are deferred. The application reads CourtReserve organization `10243`; booking stays on McCarren's site.

## Start

Requirements: Node.js 24 LTS with Corepack, Docker Desktop for the container option, and your McCarren account. pnpm is pinned by the project; no global pnpm installation is needed.

From this project directory:

```sh
make install
make browser
make connect          # Only needed for initial connection or expired login
```

In the separate Chrome for Testing window, sign in normally and open the court schedule. Switch to the **Save McCarren session** tab and click **Save session**. Enter passwords and verification codes only in the provider's browser.

Choose one runtime:

```sh
make up               # Build/start Docker in the background
# Open http://127.0.0.1:4317
make down             # Stop Docker; preserve sessions, settings, and schedule
```

Or run natively:

```sh
make dev              # Build, then run the service in the foreground; Ctrl-C stops it
```

Run one calendar instance at a time. Both runtimes use the same protected `.local/` directory. Docker includes Chromium and a virtual display so the working **headed-browser** connector can run without opening desktop windows. The host-login cookies have been tested in the container. Headless provider access was blocked by Cloudflare; the default does not use it.

With the service running, open **http://127.0.0.1:4317/architecture** for the interactive, local-only system diagram. Select a flow and step through the calendar read, background collection, session setup, and refresh request.

## What the calendar shows

- Rolling seven-day week view, focused day view, individual court choices, and external booking details.
- Automatic collection of **all eight currently posted dates** (today plus seven days ahead), with every configured time row and all seven court columns verified. The eighth date is available when navigating forward.
- Explicit native **Reserve start choices**. The site does not establish supported reservation duration, price, or eligibility through the verified schedule reads, so these remain labeled unknown. Adjacent starts are never merged into an invented booking option.
- A minimum-duration filter with an explicit choice to include starts whose duration is unknown. Unknown starts are not claimed to meet the selected duration. Uncheck that option to show only verified duration matches, which may currently be empty.
- Date-specific checked timestamps, unknown coverage, errors, and stale cached data. A failed or partial refresh never clears a previously complete date or advances its success timestamp. Empty checked schedules are distinct from unknown or failed dates.
- Saved view, duration, and court filters. The dashboard reads cached data; opening it does not scrape the provider.

The collector normally checks the posted range **every 900 seconds (15 minutes) after the previous cycle completes**, independently of the dashboard tab. Closing the tab does not stop it; sleeping the computer or stopping the service does. Provider browsers close between scans to prevent idle page traffic. The local dashboard reads its cache every 15 seconds. Manual refresh coalesces with an active check and respects the same cadence/backoff.

`REFRESH_SECONDS` may be set to an integer from 900 to 3600. The earlier two-minute setting was followed by a home-IP Cloudflare rate limit on October 31; the exact triggering request was not logged. Fifteen minutes is a reduced initial setting, not a provider-approved guarantee. Rate limiting honors the provider's `Retry-After` across reconnects and restarts; transient failures back off. Login-required or provider-blocked collection pauses until the saved session changes. Local session metadata is checked separately without bypassing a provider cooldown.

**Current incident:** [2026-10-31 rate-limit findings](docs/incidents/2026-10-31-mccarren-rate-limit.md). The observed provider deadline is November 1 at approximately **1:15 a.m. EST**. Collection remains cooling down and the displayed cache remains stale until a successful verified read; a successful login alone does not establish recovery.

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
corepack pnpm exec node scripts/check-app.ts

# Docker restart/persistence acceptance check (temporarily changes then restores preferences):
corepack pnpm exec node scripts/check-restart.ts
```

Do not run the standalone live collector alongside the running service; they share the provider request budget. The original two-date feasibility probe remains available as `node scripts/mccarren.ts test-live --days=2`, but `make test-live` now uses the complete collector.

## Storage and reconnecting

- Provider cookies: `.local/mccarren/session.json`. Only CourtReserve cookies are saved—no passwords, localStorage, or unrelated browser profiles.
- SQLite cache/preferences/status: `.local/schedule.sqlite`, with its WAL files. Directories are private (`0700`), files private (`0600`), and local state is excluded from Git and Docker image builds.
- The latest full standalone live report is `.local/mccarren/full-result.json`; it contains sanitized court/start observations and coverage, never raw authenticated traffic or other players' details. The older probe's reports remain separate.
- To reconnect, run `make connect` on the host. The running service notices the updated session on its next scheduled metadata check, without restarting Docker.
- To disconnect, close the helper, stop the service, and remove `.local/mccarren/session.json` locally. Revoke the session through CourtReserve if needed. Treat session files as credentials and do not share them.
- Back up `.local/` only to private storage, with the service stopped for a consistent SQLite copy. `make down` preserves it; no provider state is baked into the image.

On a failed check, cached starts remain visible with their original timestamps. After a network/API error, also check the in-page error and source status; old successful data is not evidence of current availability. Local health checks report service/storage readiness independently of provider health.

During an active 429 cooldown, repeated reconnects and live probes do not help. Project live-probe commands refuse known cooldowns before making any provider request. Once access is permitted again, `node scripts/inspect-provider.ts --http` is a bounded, explicit diagnostic read; do not run it alongside collection. `node scripts/check-monitoring.ts` verifies the current degraded dashboard and refresh deferral using only the local service, without contacting CourtReserve.

See the [interactive diagram guide](architecture.md), [architecture and code tour](docs/architecture.md), [source findings](docs/sources/mccarren.md), [API contract](docs/api.md), [execution checkpoint](docs/execution.md), and the [implementation plan](docs/implementation-plan.md) for evidence and remaining work.
# court-tracker
