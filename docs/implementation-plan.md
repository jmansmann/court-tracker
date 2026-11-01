# Court Tracker — Implementation Plan

**Status:** McCarren-only local vertical slice implemented: full-grid collection across eight posted dates, a persistent calendar/refresh service, and host-to-Docker session reuse are live-verified. Reservation durations, prices, eligibility, exact release time, and long-term session behavior remain unknown and explicitly labeled. Jimmy deferred all other sources on 2026-10-31; see [execution.md](execution.md) and [source findings](sources/mccarren.md).
**Planning date:** 2026-10-31.
**Context:** [Research handoff](handoff.md), the planning interview, and targeted checks of official booking routes.

## 1. Goal and first-release boundary

Build a personal, read-only desktop-first dashboard for comparing tennis court openings across Brooklyn, Queens, and Manhattan. Replace repeated visits to different booking sites with a rolling seven-day calendar and duration filtering. A booking action opens the provider's site or, for a phone-only venue, its booking instructions.

The complete first-release target includes the eight named venues below, NYC Parks reservable schedules, and a static public-court catalog for the three boroughs. Deliver it incrementally, beginning with **McCarren indoor**. Account-gated or technically unverified sources remain visibly pending until validated; a catalog entry is not a working live integration.

### Confirmed product decisions

| Area | Decision |
|---|---|
| Primary device | Desktop; usable narrow-screen fallback, with mobile polish later |
| Default view | Rolling seven local calendar days starting today; focused day view available |
| Calendar grouping | Venue-level presentation, with individual courts and source details on expansion |
| Availability | Show source-native openings rather than constructing a new reservation product |
| Main filter | Slot duration; no required time-of-day filter in the first release |
| Other filters/details | Venue selection; indoor/outdoor, surface, price, booking eligibility, and neighborhood when reliable data exists |
| Missing optional data | Does not prevent inclusion; display unknown rather than inventing values |
| Public courts | Brooklyn, Queens, Manhattan catalog; explicit toggle for walk-on backups |
| Booking | Always external; no reservations, payments, cancellations, or changes |
| Runtime | Local computer first, Docker-ready; later homelab Kubernetes deployment |
| Dashboard users | One local user initially; broader access is a future architectural decision |
| Refresh | Background polling while the application is running and the computer is awake; approximately one minute where feasible |
| Provider access | Existing accounts at McCarren, USTA, Prospect Park, and NYC Parks |
| Session upkeep | Occasional manual login is acceptable; automatic renewal is desirable where supported |
| Source access strategy | Inspect real browser traffic; reproduce verified read-only requests where reliable, with hybrid and full-browser connectors available |

### Deferred

- Notifications and availability alerts.
- Travel-time calculations, routing, maps, and neighborhood geocoding services.
- Public hosting, dashboard authentication, sharing, and multiple user accounts.
- Historical availability analytics or booking-demand predictions.
- Other boroughs, cities, or sports.
- Guaranteed live coverage of every public court; walk-on courts have no live availability feed.
- Kubernetes manifests and production deployment automation until the local version is useful.

## 2. Venue and source scope

Implement one connector per booking-system family, with separate configurable source instances for organizations, venues, and inventory modes. Reuse must be verified: sharing a platform does not guarantee identical account rules, data shapes, or schedule behavior.

| Venue / inventory | Source | Existing account | Planning evidence and remaining validation |
|---|---|---|---|
| McCarren indoor | CourtReserve, organization `10243` | Yes | User-confirmed route. Inspect signed-in schedule, slot semantics, booking window, and session persistence. **First priority.** |
| USTA Billie Jean King NTC | CourtReserve, organization `5881` | Yes | Official page advertises booking up to two days ahead; court assignments occur at check-in. Validate organization differences and whether inventory identifies courts or only a court category. |
| Prospect Park indoor | AptusSoft | Yes | Official operator states a seven-day window and 2026–27 indoor season. Public fetch exposes login, not availability. |
| SPORTIME Randall's Island rentals | AptusSoft | Not confirmed | Portal supports an Associate account route. Confirm access and reuse of the Prospect Park connector; keep Parks inventory separate. |
| Cunningham indoor | CatchCorner | Not confirmed | Official booking route points to CatchCorner; dynamic schedule, account needs, and booking horizon remain unverified. |
| Commonpoint Alley Pond indoor | AccessBlume | Not confirmed | Operator states one-week advance booking. Resolve operator/Parks court-count discrepancy against actual portal inventory. |
| Sutton East club court time | Venue-specific calendar | Not required yet | Official page advertises open court time and phone reservations. Validate actual calendar content and freshness; label as published openings rather than transactional inventory. |
| Vanderbilt full tennis courts | Appointment finder / Mindbody-related flow | Not confirmed | Official pages state seven days ahead and prepaid credits. Verify actual backing system and data access; exclude practice courts by default. |
| NYC Parks reservable subset | NYC Parks reservation pages | Yes | Public HTML exposes court/time statuses and booking links. Include selected reservable locations across the three boroughs after mapping the catalog. |
| Public walk-on / permit courts | NYC Parks directory | Not applicable to live data | Static facility/access records only; display live availability unknown. |

NYC Parks has seasonal, location-specific booking rules. USTA's two-day window and some other venues' seven-day windows cannot be treated as one universal horizon. Published rules are planning evidence; validate exact release times and date-counting semantics before generating a precise not-yet-open state.

### Initial catalog policy

- Import a bounded snapshot of NYC Parks tennis facilities in the three selected boroughs; supplement with the selected operators.
- Store source URL, last verification date, borough, neighborhood when confidently known, surface, court counts when verified, and access instructions.
- Prefer operator descriptions for the relevant rental inventory, but retain discrepancies for manual resolution rather than silently combining counts.
- Separate the physical venue from indoor rentals, outdoor reservations, and walk-on access records.
- Deduplicate reservable and walk-on entries at the venue level while preserving their different access modes.
- Start the active live watchlist with the named venues and verified Parks reservable subsets. Do not automatically poll every catalog location.
- Keep walk-on visibility **off by default**, with a remembered toggle and a clearly labeled backup panel. Walk-ons never occupy confirmed-open calendar blocks.

## 3. Proposed technical architecture

### Stack recommendation

| Layer | Proposal | Reason |
|---|---|---|
| Frontend | React + TypeScript + Vite | A focused interactive calendar without a server-rendering requirement |
| UI data and calendar | TanStack Query; evaluate FullCalendar React's standard day/week views during the UI slice | Cached API reads and established calendar interactions; verify venue aggregation and accessibility before committing to a library |
| Backend | Current supported Node.js LTS + TypeScript + Fastify | Shared contracts and direct access to browser automation and HTTP parsing tools |
| Connectors | Playwright browser automation/network inspection, observed-request replay, native HTTP requests, and Cheerio | Full-browser, hybrid, and direct-request adapters in one runtime; a documented public API is not a prerequisite |
| Validation and time | Zod; a timezone-aware library such as Luxon | Validate provider payloads and correctly handle America/New_York date boundaries |
| Storage | SQLite with migrations, WAL, and bounded write transactions | Local persistence without a separate database service |
| Tooling | pnpm workspace; thin Make targets; Vitest and focused Playwright checks | Consistent local commands and meaningful verification |
| Packaging | Docker Compose with a service image and a persistent local volume | Repeatable local startup and a straightforward later container deployment |

TypeScript is the default because these sources are predominantly browser/web systems and Playwright is a first-class fit. Python is also viable, but a second runtime brings no demonstrated benefit for this scope. Go is unnecessary for the expected workload and would complicate sharing frontend/connector contracts. Reconsider only if the McCarren feasibility slice exposes a concrete dependency advantage.

No paid calendar resource plugin is assumed. The week view can use standard day columns with venue-labeled blocks; a day comparison view can use a small custom venue-lane grid if that proves clearer.

### Runtime shape

```text
Browser -> local HTTP service -> SQLite latest schedules and settings
                  |
                  +-> background scheduler -> provider connector instances
                                               |
                                               +-> HTTP / Playwright -> providers

Interactive local connect helper -> protected provider session files
```

- One application image serves the built frontend, API, and asynchronous scheduler in the first version. Refreshing continues after the dashboard tab closes.
- Keep HTTP handlers, scheduler, persistence, and connectors as separate modules so a later worker process does not require rewriting connectors.
- A browser process is created only for sources that need it, with a small bounded pool and reusable contexts; do not launch a new browser for every minute of polling.
- Browser-based sources are a first-class deployment requirement: include compatible browser binaries, system dependencies, appropriate container shared-memory settings, and resource measurements. Validate headless operation; if a source needs a headed browser, establish a tested local/container display setup during its feasibility work.
- HTTP requests from the dashboard read cached data; loading or rerendering the calendar never directly scrapes providers.
- Use a protected local data directory for SQLite and provider session files. Do not bake data or sessions into the image.
- Bind the host-facing service to loopback. Docker publishes the port on `127.0.0.1`, while the service may bind to the container interface internally.
- Document explicitly that sleeping, stopping Docker, or quitting the app stops collection. Recover with staggered due checks after wakeup.

### Suggested repository layout

```text
apps/web/                  React calendar, filters, source status
apps/service/              HTTP API, scheduler, persistence, connectors, local state
packages/contracts/       Shared validated API and connector types
scripts/                   Supported connect, collection, and status commands
scripts/diagnostics/       Provider inspection and legacy feasibility probes
scripts/checks/            Opt-in browser/runtime acceptance checks
scripts/maintenance/       Manual incident-state tools
data/catalog/              Versioned non-secret facility/source seed data
docs/                      Plan, source findings, local operating instructions
Makefile                   Documented entry points
compose.yaml               Local service and persistent data mount
```

Pin supported dependency versions during bootstrap. Add project instructions and a README as part of that milestone. The directory currently has no Git repository; initialize one only when Jimmy requests it, and keep generated sessions, local databases, and environment files excluded from future version control.

## 4. Data and connector contracts

### Core records

- **Facility:** Stable internal ID, name, borough, optional neighborhood/address, catalog provenance.
- **Inventory:** Facility ID, indoor/outdoor mode, reservation/walk-on access, season rules with verification dates, optional surface and verified court count.
- **Source instance:** Connector family, organization/location identifiers, inventory mapping, approved/configured cadence, booking-window evidence, selected polling scope, and session reference.
- **Court/resource:** Optional provider resource ID and label. May instead represent a court category or pooled inventory; never invent a physical court number.
- **Schedule observation:** Inventory/source IDs, source slot ID if available, optional court/resource, start/end instants, source-native status and label, observation time, booking action, optional price and requirements.
- **Coverage/check:** Source instance, requested inventory and local-date partition, authoritative covered interval, completion state, last attempt, last success, next due time, and redacted error classification.
- **Preferences:** Selected venues, visible date/day view, duration filter, optional filters, and walk-on toggle. Store locally; no dashboard identity model yet.

Use UTC instants for storage and transport, with `America/New_York` as the explicit facility/display timezone. Treat date-only provider queries as New York dates. Test DST transitions, including the upcoming November clock change; do not rely on the computer's current timezone or add fixed 24-hour increments to local dates.

### Keep three different concepts separate

1. **Inventory availability:** Available, explicitly unavailable, or unknown. Keep the provider's original status label.
2. **Coverage/release state:** Successfully checked, known not yet open for booking, known out of season, unsupported scope, or unknown. An empty response alone proves none of these.
3. **Source health/freshness:** Healthy, delayed/stale, rate-limited, needs login, incomplete/parse error, or disabled/pending setup.

Walk-on is an access mode, not a claim that a time slot is available. A failed connector cannot convert cached openings to fresh availability, and a provider that only lists free times cannot establish that every missing time is booked.

### Normalization rules

- Preserve source-native reservation options, duration, inventory granularity, and any verified minimum/maximum booking constraints.
- Do not join adjacent openings across different courts or infer a 90-minute reservation from separate 30-minute offers unless the provider explicitly supports that selectable window on the same resource.
- **Duration behavior:** No filter by default; a selected duration means show source-supported options at least that long. Keep the actual offered duration visible. Finalize the exact control after inspecting McCarren's slot model.
- If a provider publishes a free interval rather than a purchasable slot, distinguish it and state any unknown reservation constraints. Do not imply a transaction duration is supported without evidence.
- Group visual blocks only where the venue, inventory mode, interval, availability, and relevant requirements match. Keep distinct court options and prices in the detail panel.
- Prices include currency and basis when known: per court, per hour, per slot, credits, or an unverified estimate. Unknown prices never become zero.
- Eligibility is available/blocked/unknown only where evidence supports it; having an account does not prove membership, a current waiver, credits, or permit eligibility.
- Preserve a valid provider deep link when stable; otherwise link to the correct organization schedule and show date/time instructions. Do not promise exact preselection if it is unavailable.

### Connector interface

Each adapter declares capabilities and its selected transport (`http`, `browser-assisted`, `browser-network`, or `browser-dom`), and implements a read-only schedule fetch for an explicit source instance and bounded date range. Return normalized observations **and** authoritative coverage/completeness, requirements, observation times, and typed failure results. Session setup is a separate interactive operation. Transport-specific behavior stays inside the connector; the scheduler and UI consume the same contract.

The interface must distinguish empty-but-complete, partial results, login-required, rate-limited, unsupported date range, and parse failure. Provider errors stay isolated to that instance. Validate external payloads at the adapter boundary and reject unexpected login pages or error documents before replacing cached data.

### Browser discovery and transport selection

Begin each dynamic-source investigation in the normal signed-in browser. Lack of a documented public API is not a reason to defer a venue. Reverse engineering requests used by that account's schedule view is part of the planned connector work.

1. **Observe the real flow.** Open the calendar and change dates, courts, and duration as a user would. Inspect Fetch/XHR responses, relevant GraphQL operations or WebSocket messages if present, embedded page data, and rendered content. Inspect client code/configuration only as needed to understand the observed schedule flow.
2. **Identify the request contract.** Record endpoint, method, query/body fields, organization/resource IDs, pagination, date/timezone semantics, response schema, and required session/token handling. Distinguish schedule reads from operations that reserve, hold, modify, or pay for a court. A read operation may use POST; its actual behavior determines whether it belongs in the connector.
3. **Reproduce a minimal read request.** Try the observed schedule call through an authenticated HTTP client or Playwright's browser-context request client. Carry required cookies, authorization, CSRF tokens, and origin/referrer headers as observed. Derive expiring values from the live session rather than hardcoding a copied token or entire browser header set. Keep sensitive values local and out of recorded examples.
4. **Validate fidelity.** Compare request results with the visible calendar across different dates/resources, empty states, and a session renewal. Verify that filters, membership context, pagination, and booking-window restrictions are preserved. Successful HTTP status alone does not establish correct inventory.
5. **Choose the lightest reliable transport below.** Keep a browser-backed path where necessary; moving from browser extraction to direct requests is an optimization, not a condition for inclusion.

| Transport | How it works | Appropriate use |
|---|---|---|
| Direct HTTP | Read public HTML, a documented API, or a verified internal schedule endpoint using the required session state | Works independently after validation and minimizes browser work |
| Browser-assisted requests | Keep browser login/session/bootstrap available, then make schedule requests through its request client or same-origin page `fetch` | Session tokens or runtime state require browser help; the browser-context request client shares cookies but does not reproduce all page execution or browser behavior |
| Browser-network capture | Navigate the real schedule UI and parse the relevant responses/messages it produces | The site's own execution is required to make reliable requests, but structured results can still be extracted |
| Browser DOM extraction | Use Playwright to navigate dates, select inventory, expand/load results, and parse the rendered schedule | Structured responses are absent, insufficient, or harder to interpret reliably than the UI |

For DOM extraction, wait for specific schedule requests or stable UI states, handle pagination/lazy loading explicitly, prefer semantic/stable selectors, and check date/organization identity before accepting results. Bound navigation retries and timeouts; detect login redirects, partial grids, and selector drift. Do not count the initial rendered viewport as complete unless the source's behavior proves it covers the requested scope.

Each source's findings document records the selected transport, sanitized request/response shape or selector strategy, completeness checks, session renewal behavior, request/browser cost, and any tested fallback. A fallback must satisfy the same coverage contract and share the same rate budget. Do not trigger additional browser/replay attempts indefinitely after a login failure or rate limit.

### Snapshot replacement and retention

- Publish observations transactionally for a complete source/inventory/date partition. Replace only the scope actually checked, including removing vanished openings in that confirmed scope.
- Partial or failed checks retain the last complete partition with explicit stale/incomplete status; they do not clear the calendar or advance its success timestamp.
- Never use one successful day or organization check to mark an entire provider's week fresh.
- Keep the latest schedule snapshot, prune past slots, and retain limited operational check metadata for seven days. No historical availability archive in the first release.
- Do not retain other players' names, reservation identities, or raw authenticated response dumps. Diagnostic fixtures must be sanitized.

## 5. Polling and provider sessions

### Scheduling

- Target a complete selected seven-day refresh about every 60 seconds where the actual request budget and source behavior support it. A connector may require one request or many; measure this rather than equating one poll with one request.
- Poll only dates inside verified booking windows and known active inventory seasons. Continue lightweight checks for opening-window transitions as needed.
- Keep the default rolling week as the background scope. Navigating elsewhere reads existing coverage and may request a bounded, rate-budgeted check; it does not permanently expand the background polling horizon.
- Configure cadence and concurrency per provider family and source instance. Apply shared provider limits across organizations, not just independent timers per venue.
- Start with conservative bounded concurrency, stagger source/date checks, add jitter, and prohibit overlapping work for the same partition.
- Prefer verified read endpoints discovered through normal browser use, including undocumented internal endpoints. Use conditional requests where meaningful. Retain browser-assisted, response-capture, and rendered-extraction options; undocumented endpoints and UI selectors both require change detection and maintenance.
- Honor `Retry-After`, back off on transient failures/rate limits, and stop repeated login attempts when interaction is required. A slow or failed source must not block other venues.
- Requesting refresh manually coalesces duplicate work and respects the same limits; it is not a rate-limit bypass.
- Give source/date partitions visible timestamps and a proposed stale threshold of `max(2 × effective cadence, 120 seconds)`. Display errors immediately even before that threshold.
- The dashboard checks its local API around every 15 seconds while visible and immediately on focus; this is separate from provider polling.

The research handoff records scraping permission as accepted. Record known source-specific cadence/retention conditions during connector setup and configure accordingly. No public documentation reviewed establishes that minute-level automated access is supported by every provider.

**Current McCarren constraint:** both the initial 120-second cadence and the later 900-second cadence preceded home-network HTTP 429s. No request quota or approved cadence has been established. Collection is disabled by default (`COLLECTION_ENABLED=false`) until McCarren/CourtReserve confirms an acceptable automated read budget/cadence or a supported integration.

### Connecting accounts

- Provide a local interactive connect command that opens a headed browser for the user to complete the provider's normal login flow, including MFA if required.
- Persist only the session state needed for read access in protected local files. Session storage must be provider/organization scoped as necessary; do not assume CourtReserve or AptusSoft organizations can share a session.
- Validate host-browser session reuse from the Docker runtime in the McCarren slice. If a portal depends on nonportable state, resolve the runtime/login approach there before scaling to more connectors.
- Reuse valid sessions and normal supported token refresh. First release does not require stored passwords or automated MFA.
- When renewal needs interaction, mark the source as needing login, retain clearly stale data, and provide a reconnect instruction.
- Keep tokens, cookies, credentials, and personal provider data out of API responses, logs, fixtures, and source control. Provider state is never sent to the frontend.
- Render provider labels as text and validate external booking URLs. Restrict local control endpoints to expected same-origin requests.

## 6. API and UI contract

### Initial API surface

| Route | Purpose |
|---|---|
| `GET /api/facilities` | Filterable, paginated static catalog and inventory modes; defaults to the three selected boroughs |
| `GET /api/schedule` | Bounded date range, venue IDs, duration and optional filters; observations plus partition coverage/freshness |
| `GET /api/sources` | Redacted setup/health status, effective cadence, last success and next due; no session data |
| `GET /api/preferences` / `PATCH /api/preferences` | Local display/watchlist preferences; validate changes |
| `POST /api/refresh-requests` | Enqueue/coalesce allowed read-only refresh work and return accepted/deferred status |
| `GET /health/live` / `GET /health/ready` | Process health and storage readiness; provider failure does not fail service readiness |

Use typed request/response schemas and one structured error shape. Bound schedule queries to a maximum seven-day window per request; users can navigate to another week. Responses must describe uncovered/out-of-window dates rather than returning misleading empty availability. Include a snapshot/revision marker for efficient client refresh and a consistent observation timestamp contract.

### Desktop experience

- Sidebar: borough/venue selections, duration, best-effort metadata filters, walk-on toggle, and compact connector status.
- Week: day columns and time-aligned, venue-labeled opening blocks. Use consistent venue colors plus text labels; avoid encoding meaning in color alone.
- Day comparison: venue lanes aligned to the same time axis for answering “which venue has something around this time?”
- Details: available courts or resource category, real duration, price/basis, indoor/outdoor and surface, requirements, observed time, and external booking action.
- Source state: explicit loading, never connected, no openings in checked scope, not yet released, rate-limited, needs login, parse failure, and stale cached data.
- Walk-ons: separate backup list with neighborhood, access rules, season notes, and directory link; clearly no live feed.
- Keep selected filters through refreshes. An unavailable price/surface/eligibility value stays visible by default; selecting an explicit strict filter may exclude unknowns, with the behavior labeled.
- Keyboard-operable filters and details, readable contrast, and a list-style fallback for smaller screens or dense overlaps.

During the UI slice, validate that a busy seven-day grid remains scannable with all selected venues. If overlaps are too dense, summarize by venue within each time range and expand details; do not silently hide openings.

## 7. Implementation sequence and exit criteria

### M0 — McCarren feasibility and operating contract

**Work:** Use the existing account locally to inspect the normal read-only schedule and its network traffic; record sanitized findings in `docs/sources/mccarren.md`. Reproduce observed schedule requests and compare with browser-rendered results; establish browser-network or DOM extraction if direct requests are unreliable. Identify source-native slot semantics, booking release rules, price visibility, link-out behavior, session expiry, and actual request/browser cost for the seven-day range. Test interactive session capture and reuse from the intended container environment. Use a minimal disposable probe to establish feasibility before building the production connector.

**Exit:** Demonstrate extraction of time-specific McCarren openings, or a clear verified blocker after evaluating browser-backed access as well as direct requests; define the connector contract from actual evidence. Record the chosen transport, confirm a workable login/runtime path and an initial measured cadence, and compare multiple dates with the provider's visible schedule, including an empty or unavailable state where available.

**Dependency decision:** If blocked, report the cause and agree on the next indoor source rather than silently replacing McCarren. USTA and Prospect Park are the next candidates; NYC Parks can independently validate public parsing.

### M1 — Bootstrap and one-venue end-to-end vertical slice

**Work:** Establish workspace, shared contracts, migrations, local service, McCarren connector, scheduler, minimal React calendar, external booking details, and source freshness. Add Docker Compose, session connect command, README, and thin `make help`, `make dev`, `make up`, `make down`, `make connect`, and `make verify` targets.

**Exit:** Start locally from documented commands, connect McCarren, see its real slots for the verified booking horizon in a seven-day view, filter by supported duration, and open the correct external provider flow. Refresh continues after closing the tab. Restart preserves session/settings/cache. Cached data is labeled stale after failed checks. Host-to-container session handling has been demonstrated.

### M2 — CourtReserve reuse and public-court baseline

**Work:** Add USTA as a distinct CourtReserve source instance; implement its verified horizon and resource semantics. Add NYC Parks HTML connector, import the three-borough catalog, map selected reservable subsets, and provide the walk-on toggle and backup list.

**Exit:** Compare McCarren, USTA, and selected Parks schedules without confusing different booking windows or access modes. Represent USTA court categories correctly if physical court numbers are not exposed. Walk-ons never show as free time. A failure in one organization/source leaves the others current.

### M3 — AptusSoft and useful multi-venue calendar

**Work:** Validate and implement Prospect Park using the existing account, then SPORTIME if its required account/view is available. Complete week/day comparison, court details, persisted venue selection, optional metadata display, and unknown-data behavior.

**Exit:** McCarren, USTA, Prospect Park, and Parks form a reliable multi-provider dashboard. SPORTIME is live or explicitly pending access with documented evidence. Compare source slots and booking actions at several dates/times; verify that grouping does not merge incompatible options.

### M4 — Remaining selected providers

**Work:** Perform the same bounded discovery and connector implementation for Cunningham/CatchCorner and Commonpoint/AccessBlume, then Vanderbilt's actual finder and Sutton East's published calendar. Acquisition of any necessary accounts is an explicit dependency. Exact ordering within this milestone can follow validated access and implementation friction.

**Exit:** Each remaining venue has verified live/published openings with appropriate confidence labels, or a documented blocker and useful static link-out. A blocked venue is not counted as completed live coverage. If a source proves infeasible, agree on its reduced first-release behavior or deferral before calling the full scope complete.

### M5 — Reliability and first-release acceptance

**Work:** Exercise throttling, session expiry, parser changes, wake-from-sleep, restart, and DST behavior. Measure request counts, refresh cycle duration, browser resource use, and UI responsiveness with the selected sources enabled. Finish concise local recovery and backup instructions.

**Exit:** All feasible selected sources satisfy the checks below; outstanding source scope is explicitly agreed. Docker startup, persistent data, reconnect, visible freshness, and isolated failures work as documented. Review actual behavior-changing changes before declaring implementation complete.

Do not spend the first milestones building a general connector marketplace, distributed queue, multi-user accounts, or Kubernetes deployment. The key early proof is a usable McCarren calendar backed by actual observed inventory.

## 8. Verification strategy

- **Connector fixtures:** Sanitized examples of availability, true empty results, login pages, and changed/malformed data. Test normalization and authoritative coverage, not implementation details.
- **Provider-browser adapters:** Controlled pages/responses for date navigation, delayed rendering, pagination, response correlation, and selector drift where those behaviors exist. Targeted live comparisons verify that a reproduced request agrees with the signed-in schedule and still works after session renewal. Test any implemented fallback against the same expected normalized data and coverage.
- **Storage integration:** Scoped atomic replacement, disappeared slots after a complete refresh, preservation after partial/error responses, and independence of organizations/date partitions.
- **Time and filtering:** New York local dates, DST changes, source-native duration matching, source windows, nullable prices, and unknown eligibility. No cross-court synthetic availability.
- **Scheduler:** Fake-clock checks for nonoverlap, provider-wide budgets, backoff/`Retry-After`, manual-refresh coalescing, and session-required pauses.
- **Browser checks:** Calendar/day comparison, filters, detail/booking links, walk-on separation, stale/login/error states, and basic keyboard use against controlled data; targeted manual comparison against the live source.
- **Container smoke check:** Fresh startup, migration, host-assisted session handoff, polling with the tab closed, restart persistence, and graceful shutdown.
- **Quality gate:** `make verify` runs formatting/lint, type checks, focused automated tests, and production build. Live provider checks are explicit opt-in checks rather than credential-dependent CI tests.

Performance is measured rather than assumed: publish the observed requests per source refresh and achievable cadence. The target is roughly one-minute observations where supported, not a guarantee that an external booking site or sleeping computer delivers a one-minute end-to-end update.

## 9. Later homelab and sharing path

- Reuse the service image, health endpoints, environment-based configuration, and persistent data layout.
- Start with one active scheduler and a suitable persistent volume. SQLite requires local-filesystem locking semantics; do not place it on an arbitrary shared/network filesystem or scale writers without a design change.
- Separate the worker or move to Postgres only when deployment topology or additional users make it necessary.
- Rework provider connection/session access for a remote runtime; a local headed-login helper is not automatically a Kubernetes login solution.
- Before network exposure or sharing, add dashboard authentication, authorization, tenant/user-scoped provider sessions, and appropriate secret management. These are future requirements, not assumed capabilities of the local version.

## 10. Open decisions and evidence gaps

### Resolve during M0, before committing to connector implementation

1. What exactly does the McCarren signed-in schedule expose: discrete offers, continuous free intervals, court identity, prices, release rules, and durable booking links?
2. Can its session be reused across the interactive local helper and Docker worker, and how does expiry/reconnection behave?
3. What request pattern/cadence completes the desired range reliably and respects provider-confirmed constraints? McCarren's acceptable cadence is currently unknown; do not infer it from the observed Retry-After deadline.
4. Which transport is reliable: direct replay of observed requests, browser-assisted requests, browser-network capture, or rendered DOM extraction? What browser/container resources does it require?

### Resolve per source, without blocking unrelated venues

- Account access for SPORTIME, CatchCorner/Cunningham, AccessBlume/Commonpoint, and Vanderbilt; actual waiver/member/credit/permit eligibility for existing accounts.
- Booking horizons, exact release times, and seasonal modes where unverified.
- Commonpoint's conflicting court counts and the actual rentable portal inventory.
- Vanderbilt's current finder integration and full-court versus practice-court inventory.
- Whether Sutton East's calendar supports timely structured openings; retain phone-booking semantics regardless.

### Approved defaults

- TypeScript backend and frontend; React/Fastify/Playwright/SQLite stack above.
- Walk-on toggle initially off, with remembered preference.
- Duration control means minimum supported source-slot duration, with no filter by default.
- Latest schedule snapshots only; operational check metadata retained for seven days.

## 11. Primary-source references

Fetched public routes validate booking destinations and published rules; most indoor portals returned login forms or JavaScript shells, not usable live inventory. No authenticated connector is validated by this planning document.

- McCarren, user-supplied CourtReserve organization: <https://app.courtreserve.com/Online/Portal/Index/10243>
- USTA booking information: <https://ntc.usta.com/book-a-court>
- USTA CourtReserve organization: <https://usta.courtreserve.com/Online/Portal/Index/5881>
- Prospect Park information: <https://www.prospectpark.org/visit-the-park/places-to-go/tennis-center/>
- Prospect Park published rates/season information: <https://www.prospectpark.org/visit-the-park/places-to-go/tennis-center/outdoor-tennis-information/>
- Prospect Park portal: <https://prospectpark.aptussoft.com/member>
- SPORTIME: <https://www.sportimeny.com/manhattan> · <https://sportime.aptussoft.com/member>
- Cunningham: <https://cunninghamtennis.com/book-court-online/> · <https://www.catchcorner.com/facility-page/embedded/rental/1253>
- Commonpoint: <https://commonpointtennis.org/court-rentals> · <https://us.accessblume.com/customerapp/cq/login>
- Sutton East: <https://suttoneasttennis.com/courttime/> · <https://suttoneasttennis.com/court-time-availability/>
- Vanderbilt: <https://vanderbilttennisclub.com/online_reservations/> · <https://vanderbilttennisclub.com/app-req/>
- NYC Parks catalog: <https://www.nycgovparks.org/facilities/tennis>
- NYC Parks rules: <https://www.nycgovparks.org/tennisreservation/moreinfo>
- Example public schedule: <https://www.nycgovparks.org/tennisreservation/availability/2>
