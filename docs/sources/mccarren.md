# McCarren CourtReserve connector findings

**Updated:** 2026-11-01. The initial two-date feasibility probe is now extended to full-grid collection, all eight posted dates, a cached local calendar, and a Docker-headed-browser runtime. Other data sources are deferred by Jimmy's instruction.

**Current health:** Home-network schedule access is Cloudflare rate limited, while cellular access works. A second 429 followed 11 successful 15-minute collection cycles. The latest recorded effective not-before deadline is **2026-11-02 13:55:41 UTC / 08:55:41 EST**. Collection is now disabled by default; cached observations below are historical, not fresh inventory. See the [incident report](../incidents/2026-10-31-mccarren-rate-limit.md). No provider-approved quota or cadence is known.

## Access and transport

- Organization `10243`; normal schedule: <https://app.courtreserve.com/Online/Reservations/Index/10243>.
- Jimmy signed in through the isolated local helper. Only CourtReserve cookies are saved in protected ignored storage. A fresh native headed context and the container's headed Chromium/Xvfb runtime successfully reused them.
- Working transport: the normal signed-in browser's **DOM Reserve controls**, correlated with validated structured schedule responses. The feasibility probe also reproduced observed schedule GETs with matching scheduling projections on two dates. Production collection does not duplicate every request with a replay.
- Headless Chromium was blocked by Cloudflare, both with and without cookies. The service uses a headed browser; Docker supplies a virtual display. No stealth modifications or challenge bypasses are used.
- Each collection opens a headed browser context and closes it after the scan. CourtReserve remembers its last viewed date within a cycle, so the connector uses the normal **Today** button to reset before walking the range. A real second-cycle failure exposed this behavior; cached complete partitions were retained with errors, and the fix was subsequently verified by a successful background cycle with the dashboard closed.
- A source login/block failure pauses repeated provider attempts until the saved session changes; only local session metadata is checked while paused. The failing revision is private persisted scheduler metadata, so restarting the service does not bypass the pause. Expiry and token renewal over days remain unmeasured.

## Verified read requests

| Method | Endpoint                                                            | Role                                                         |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `https://app.courtreserve.com/Online/Portal/PortalNavigation/10243` | Signed-in organization identity flags                        |
| GET    | `https://app.courtreserve.com/Online/Reservations/Bookings/10243`   | Scheduler configuration, time bounds, seven court labels/IDs |
| GET    | `https://backend.courtreserve.com/api/scheduler/member-expanded`    | Date-specific schedule entries                               |

The schedule query keys include `id`, `jsonData`, and `RequestData`. The observed JSON includes organization/date/timezones, filters, membership context, interval, and runtime request data. `selectedDate` is a New York `YYYY-MM-DD`; `kendoDate.month` was one-based. Expiring values are derived by the normal browser flow; they are never copied into recorded examples or exposed by the API.

The structured response has `Data`, `Total`, and `Errors`. Every row's start/end timestamp and envelope completeness are validated. Raw data may contain private reservation fields and remains in memory only. No names, descriptions, reservation identities, raw bodies, full request URLs, headers, cookies, or tokens are retained in reports. Short DTOs may have `OrgId: 0`/`CourtId: 0`; the connector does not infer court identity or free time from those rows.

## Measured request cost and repeat 429

A normal full scan performs **10 recognized API reads**: one organization/login-flags GET, one schedule-configuration GET, and one schedule-data GET for each of eight dates. Each **Next day** action advances to one new schedule-data read. Scrolling the grid across three viewports per date is DOM inspection; the collector does not make one schedule request per court or time cell. Date navigation from the dashboard itself reads SQLite only. The 10-count does not include page navigation, static assets, telemetry, or other unmeasured browser traffic.

The local refresh history for November 1 records 11 successful scheduled scans, each with 10 recognized reads, from **11:06:56 through 13:40:28 UTC**. A further scheduled scan began at **13:55:28 UTC**, made 9 recognized reads, completed five of eight dates, then received HTTP 429. That is **119 recognized API reads in about 2 hours 49 minutes**, plus uncounted browser traffic. It shows that the 15-minute cadence was still not safe for this home-network path; it does not reveal the provider's threshold or counting key.

The first incident's response had `Retry-After: 61,599` seconds. For the second 429, local history records an effective not-before deadline exactly one day after the response, **2026-11-02 13:55:41.121 UTC**. The raw second response header was not retained. Connector and scheduler code cap a Retry-After at **86,400 seconds**, so the provider may have sent exactly one day or a longer value that was capped locally. An absent/invalid header uses a one-hour fallback and would not explain this effective 24-hour deadline.

HTTP 429 means a client exceeded a request rate, but [RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4) does not define how a server counts requests or identifies the limited client. Cloudflare's [rate-limit parameters](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/) describe configurable count keys such as IP/path and list a one-day (`86400` second) mitigation duration. This makes a one-day Cloudflare mitigation technically plausible; it does **not** establish which rule, threshold, or key McCarren/CourtReserve uses.

Collection is now disabled by default with `COLLECTION_ENABLED=false`; the local dashboard remains available from cache. Do not set `COLLECTION_ENABLED=true` until McCarren/CourtReserve confirms an acceptable request budget/cadence or a supported integration. The 900-second prior setting was not a provider-approved limit.

## Full grid and native start semantics

- Configuration reports seven courts, 30-minute grid ticks, and operating schedule bounds **06:00–23:59 New York time**. Every time row from 06:00 through 23:30 and every configured court column must be observed before publishing a complete source partition.
- The collector scrolls vertical and horizontal viewports with overlap, unions/deduplicates Reserve controls, verifies every court/time combination against actual normal-flow body-cell geometry, and rejects missing headers/rows/body content, clipped viewports, loading indicators, selector drift, unexpected dates, and changing scroll extents. Co-visible axes alone cannot establish completeness. The observed desktop layout needs three vertical viewports per date.
- Free controls expose `data-testid="reserve-slot-btn"`, `data-slot-start="HH:mm"`, `data-court-label`, and an accessible label such as `Reserve Court #2 6:00 AM`. Label, time, and court are cross-validated. Court #1's provider label is **Court #1 (Singles Court)**; labels #2–#7 are preserved too.
- Controls can be provisional during loading. A next-day transition briefly showed 112 provisional Reserve labels before settling to 28 in its initial viewport. The collector waits for zero busy indicators, the expected date, and stable samples. Normally Next must be enabled; the verified final posted date intentionally disables Next and is accepted only at the validated terminal boundary after its correlated API response and full-grid checks.
- `DaysACourtCanBeReservedInAdvance: 7` was verified as **today plus seven following dates**: eight total, ending November 7 on the October 31 observation. Next is disabled on that final date. There is no unbounded date-click loop. Exact release time and how the window changes at midnight remain unmeasured.
- A Reserve control is a **native start choice**, not evidence of a purchasable 30-minute duration. Each marker remains separate, with duration/end/price null and eligibility unknown. No reservation/create/hold/payment flow was entered. The configuration's `AllowMemberToBook` was false despite visible Reserve controls, reinforcing the need to keep eligibility unverified.
- Complete coverage means the entire configured source grid was read. It does not mean that missing starts are explicitly booked, or that all reservation durations at those starts are known. Controlled browser fixtures test true empty full grids; no naturally empty entire live date was encountered.

## Authenticated full-range comparison

Standalone `node scripts/collect.ts`, at approximately **05:21 UTC on 2026-10-31**:

| New York date | Structured rows / Total | Native starts across full grid | Viewports |
| ------------- | ----------------------: | -----------------------------: | --------: |
| 2026-10-31    |                 83 / 83 |                             45 |         3 |
| 2026-11-01    |                 85 / 85 |                             45 |         3 |
| 2026-11-02    |                 88 / 88 |                             20 |         3 |
| 2026-11-03    |                 98 / 98 |                             18 |         3 |
| 2026-11-04    |                 95 / 95 |                             21 |         3 |
| 2026-11-05    |                 94 / 94 |                             12 |         3 |
| 2026-11-06    |                 94 / 94 |                             22 |         3 |
| 2026-11-07    |                 83 / 83 |                             49 |         3 |

All eight partitions passed: **232 start choices, 20.7 seconds, ten recognized provider reads**. The final stricter body-cell-coverage rerun at **05:44:47 UTC** reproduced all eight dates/counts in **19.8 seconds** and ten reads. This excludes assets, telemetry, and ancillary portal requests. The original initial-viewport probe found only 15/28 starts on the first two dates, demonstrating why full-grid scrolling was necessary.

DST was exercised live: 06:00 October 31 maps to 10:00 UTC, while 06:00 November 1 maps to 11:00 UTC. Source coverage ends at 23:59 local, not a fixed UTC offset. Tests reject ambiguous/nonexistent local start times.

## Application/runtime evidence

- Docker image built with matching Chromium and dependencies, Xvfb, persistent `.local/` bind mount, and loopback-only publishing. Host session cookies were read successfully inside the container.
- First complete container refresh succeeded at 05:23:46 UTC. After the remembered-date correction, a complete refresh succeeded at 05:28:23 UTC, followed by another automatic refresh at **05:30:42 UTC** with no dashboard browser tab open. This verifies browser/context reuse and background operation.
- The seven-day dashboard showed **183 native choices** (the first seven rows above), with no browser console/page errors. Grouped week markers retain separate selectable court options in details; day/mobile views show individual starts. The eighth date is cached and visible when navigating forward.
- Final Docker build/health, actual application-browser verification, and actual restart persistence checks passed after the review corrections. Seven complete partitions/183 starts and nondefault display preferences survived restart; original preferences were restored. The final quality gate passed 51 tests, type/format checks, and the production build; dependency audit reported no known vulnerabilities. Controlled connector tests additionally cover eight-date traversal, remembered-date reset, and failure-only cancellation during context setup without reading private sessions or contacting providers.
- The initial polling setting was **120 seconds after each cycle**. It was followed by a home-network rate limit; changing to **900 seconds** still resulted in a second 429 after 11 successful cycles. Collection is now **disabled by default**, with explicit cooldown enforcement and provider browsers closed between cycles. Neither previous cadence was provider-approved. Sleep/stopping the runtime also halts collection.

## Remaining evidence gaps

- Native reservation duration, price, account eligibility, and exact external date/time preselection remain unknown. The UI labels them accordingly, and strict duration filtering excludes unknowns when requested.
- Exact booking release time and long-duration session expiry/renewal need observation over time.
- A natural entirely empty live date was not observed; controlled tests cover empty, missing-row, malformed, stale/login/error, and delayed-render cases.
- Long-running provider behavior, rate limiting under sustained use, and runtime resource use beyond these bounded runs still need operational measurement. Other sources are not part of this slice.
