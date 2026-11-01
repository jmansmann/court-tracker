# Court Tracker — Interactive architecture companion

`architecture.html` is the clickable version of this guide. When the local app is running, open **http://127.0.0.1:4317/architecture**. The page is self-contained: it makes no API or provider requests and loads no external fonts or scripts. It also works when opened directly from disk.

## System at a glance

Court Tracker is a local, read-only McCarren indoor calendar. A React dashboard asks a Fastify service for cached data. In the same Node.js process, a scheduler starts a Playwright connector in the background. The connector reads McCarren's signed-in schedule, checks the full grid, and publishes verified date partitions to SQLite. Booking always remains on McCarren's site.

```text
Dashboard browser ── GET /api/schedule ──> Fastify API ── read ──> SQLite cache
                                               │                         ▲
                                               └── refresh request ─> Scheduler
                                                                      │
                                                             McCarren connector
                                                                      │
                                                            Headed Playwright
                                                                      │ read-only
                                                                 CourtReserve

make connect ── sign in normally ──> private cookie file ──> connector
```

The important separation is **cache reader versus cache writer**. Loading the dashboard does not scrape CourtReserve. The UI polls cached data every 15 seconds; the provider collector normally runs every 900 seconds after the previous cycle completes.

## Components

| Component                      | Responsibility                                                                                                                 | Code                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Dashboard browser              | Renders the React calendar; filters and navigates cached starts.                                                               | `apps/web/src/App.tsx`                                         |
| Fastify API                    | Serves the built UI and validated local API routes. Schedule GETs read SQLite only.                                            | `apps/service/src/http.ts`                                     |
| Refresh scheduler              | Runs one collection at a time, tracks session changes, coalesces manual requests, and enforces backoff/cooldown.               | `apps/service/src/scheduler.ts`                                |
| McCarren connector             | Uses the signed-in page, checks organization/date identity, extracts full grids, and emits complete or failed date partitions. | `apps/service/src/connectors/mccarren.ts`                      |
| Playwright browser             | Headed Chromium used during a single provider scan; it closes when that scan finishes. Docker supplies Xvfb.                   | `apps/service/src/connectors/mccarren.ts`                      |
| CourtReserve                   | External provider, McCarren organization `10243`; schedule is read-only and booking is external.                               | `docs/sources/mccarren.md`                                     |
| SQLite cache                   | Latest date snapshots, per-date check history, preferences, source status, and refresh run history.                            | `apps/service/src/store.ts`                                    |
| Session helper and cookie file | `make connect` lets the user authenticate in a separate browser; only cookies are stored privately.                            | `scripts/connect.ts`, `apps/service/src/connectors/session.ts` |
| Shared local state             | Symlink-safe, permission-restricted local JSON storage used by the service, connector, and operator tools.                     | `apps/service/src/local-state.ts`                              |
| Shared contract                | Zod-validated schemas and types for openings, partitions, preferences, API responses, and source health.                       | `packages/contracts/src/index.ts`                              |

## Flows shown in the diagram

### 1. View the calendar

1. The dashboard requests up to seven dates from `GET /api/schedule`.
2. Fastify asks the store for the cached partitions, preferences, source status, and revision.
3. The service returns per-date openings, coverage, stale/error details, and source health.
4. The browser applies display filters and renders the calendar. It never contacts the provider.

### 2. Background collection

1. The scheduler waits for its next due time and checks the saved-session revision and provider cooldown.
2. It calls the shared `ScheduleConnector` contract for today plus seven ahead: eight New York-local dates.
3. The connector loads the cookie-only session and launches a headed Playwright context.
4. Playwright reads CourtReserve's normal schedule view and advances through the dates.
5. The connector validates the structured response and every configured court/time cell in the rendered grid.
6. Each observed `Reserve` control becomes one `reserve-start`; duration, end time, price, and eligibility remain unknown.
7. The connector reports a complete or failed result for each date.
8. The store transactionally replaces a complete date snapshot. A failed result adds error/check history but retains that date's last successful snapshot.

The source is marked healthy only after all eight dates complete. A partial scan may update successfully checked dates while failed dates remain stale. A missing start marker is not proof that a time is booked.

### 3. Connect the session

1. `make connect` opens a separate browser for the user's normal provider login.
2. The helper verifies McCarren organization access and saves only provider cookies in `.local/mccarren/session.json`.
3. The collector loads the cookie state into its own fresh context. Provider cookies and raw authenticated responses are never returned to the dashboard.

### 4. Request a refresh

1. The dashboard sends an empty JSON body to `POST /api/refresh-requests`.
2. Fastify asks the scheduler to consider work.
3. The scheduler returns `accepted`, `coalesced`, or `deferred` according to active work, cadence, backoff, and provider cooldown.
4. The browser shows the decision. A manual click cannot bypass provider limits; any accepted collection uses the same background flow above.

## Deployment shape and modes

This is a **single local deployment shape**, so the interactive diagram has no mode toggle. `make dev` and Docker Compose run the same logical services. Docker packages headed Chromium with Xvfb and publishes the service on host loopback; native mode binds directly to host loopback. Both use the same `.local/` state directory, and only one runtime should run at a time.

The project currently supports one source, one local user, one SQLite store, and one scheduler process. `ScheduleConnector` is a useful seam, but the shared contract and source status still contain McCarren-specific values; other venues are not yet implemented.

## Data facts the diagram preserves

- A `Reserve` marker is a provider-observed **start choice**, not a confirmed reservation or evidence of a supported duration.
- `coverage` describes whether that date's configured grid was verified; `unknown` coverage is not an empty schedule.
- Source health/freshness is separate from both the presence of a start and per-date coverage.
- Date labels are `America/New_York`; instants are stored/transported with UTC offsets.
- A failed or partial check does not clear a prior complete partition or advance its success timestamp.
- Current reservation duration, price, eligibility, exact release time, and long-term session renewal remain unverified; see the source findings and current incident notes.

## Reading the implementation

For a deeper code walkthrough, storage model, and API map, read [`architecture.md`](architecture.md). The main source reading order is:

1. `packages/contracts/src/index.ts`
2. `apps/service/src/main.ts`
3. `apps/service/src/scheduler.ts`
4. `apps/service/src/connectors/mccarren.ts`
5. `apps/service/src/store.ts`
6. `apps/service/src/http.ts`
7. `apps/web/src/App.tsx`

The latest operating status is in [`execution.md`](execution.md); provider behavior evidence is in [`sources/mccarren.md`](sources/mccarren.md).
