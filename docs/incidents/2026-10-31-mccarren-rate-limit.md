# 2026-10-31 — McCarren home-network schedule access rate limited

## Outcome and current state

**Confirmed:** CourtReserve's backend schedule read returns **Cloudflare HTTP 429** from the home network. The portal still authenticates and loads organization configuration with HTTP 200, but its schedule Fetch fails with CORS/`net::ERR_FAILED`. The website renders Reserve controls despite that failure. Those controls do not establish actual availability. A later 429 occurred after the collector had been slowed to 15-minute cycles; collection is now locally paused by default while an acceptable cadence is confirmed.

Jimmy confirmed the same phone displays real bookings on cellular and loses them again on home Wi-Fi. This strongly localizes the restriction to the home network's public-IP access, rather than deleted booking data or a club-wide empty schedule. The inspected connector clicks only Today/Next day and scrolls; it has no booking, hold, cancellation, payment, or schedule-edit operations.

**Likely contribution, not provable retrospectively:** the original eight-date scan every 120 seconds may have triggered the provider's protections. The previous logs did not retain HTTP status or all browser-lifetime traffic, so they cannot prove which request triggered the first block. A later 429 after 11 successful 15-minute cycles shows that 900 seconds is not a proven safe setting either. Neither cadence was provider-approved. The collector now defaults to disabled, with the local dashboard continuing to serve cached data.

The explicit retry requested by Jimmy at **13:08:59 UTC** returned `Retry-After: 61599`, giving a not-before deadline of **2026-11-01 06:15:38 UTC**, approximately **Sunday, November 1, 1:15 a.m. EST** after the clock change. This is a provider-supplied retry deadline, not a guarantee that access will recover then. The initial investigation made no further provider check after receiving that deadline. The follow-up cycle after that deadline is documented below; `make connect` now also refuses to make provider requests during a persisted cooldown or local pause.

## Repeat 429 after cadence reduction — November 1

Local diagnostics show 11 successful scheduled full scans from **11:06:56 through 13:40:28 UTC**. Each scan checked eight dates and recorded 10 recognized API reads. The next scheduled scan started at **13:55:28 UTC**; it recorded 9 reads, completed five dates, and then encountered HTTP 429. The run finished at 13:55:42 UTC. This is **119 recognized API reads in about 2 hours 49 minutes**, not counting page navigation, assets, telemetry, or other browser requests. Dashboard date navigation itself reads cached SQLite data; within a provider scan, each Next-day click causes a date-specific schedule read, while scrolling the grid does not make one request per court/time cell.

The latest persisted effective not-before is **2026-11-02T13:55:41.121Z** (about **8:55 a.m. EST**), 86,400 seconds after the second 429. The raw `Retry-After` value from that response was not retained. The connector and scheduler cap the applied delay at 86,400 seconds; an absent/invalid header uses a one-hour fallback. Therefore the saved one-day deadline indicates a one-day-or-longer Retry-After was applied, but it cannot distinguish a provider header of exactly 86,400 seconds from a longer value capped by local code.

No exact CourtReserve request quota, time window, or counting key is available from these observations. [RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4) defines 429 as too many requests but explicitly leaves the server's counting and client-identification method unspecified. Cloudflare's [rate-limit configuration documentation](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/) lists IP/path-style characteristics and a configurable one-day mitigation duration. That shows how a 24-hour Cloudflare limit can be configured; it does not prove which rule or threshold was applied to this account/IP.

Following Jimmy's direction, `COLLECTION_ENABLED` now defaults to `false`. The service remains available for local calendar/cache reads, but scheduled and manual provider collection are disabled until the cadence is confirmed. Provider-facing CLI commands also refuse while this local pause or a known cooldown is active, and fail closed without local status unless explicitly enabled for a one-off first-time connection. An explicit CLI opt-in does not override a saved pause or cooldown. The recorded not-before time does **not** trigger an automatic request while collection is paused.

## Evidence timeline

| UTC, October 31   | New York time    | Evidence                                                                                                                                                                          |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 06:13:23          | 02:13:23 EDT     | Last fully successful eight-date refresh in SQLite                                                                                                                                |
| 06:15:27–06:15:38 | 02:15 EDT        | Six dates refreshed successfully through November 5                                                                                                                               |
| 06:16:08          | 02:16:08 EDT     | Remaining two dates failed after a next-date read timed out; original error detail was generic                                                                                    |
| 06:18 onward      | 02:18 onward EDT | Startup schedule failures classified as unavailable; exponential backoff reached one-hour intervals                                                                               |
| 12:22–12:23       | 08:22–08:23 EDT  | Last legacy scheduled attempt; all eight checks failed, prior complete snapshots retained                                                                                         |
| 12:46:04          | 08:46:04 EDT     | Fresh headed inspection: authenticated navigation/configuration 200; schedule browser request failed; exact observed GET replay returned 429; 140 Reserve controls still rendered |
| 13:08:59          | 09:08:59 EDT     | User-requested retry: same login/config success and schedule failure; 147 Reserve controls; replay confirmed Cloudflare 429 and 61,599-second Retry-After                         |

The changing count of rendered Reserve controls with no successful schedule response illustrates why a drawn grid is not authoritative data. The dashboard's connector rejected the failed reads and preserved the prior complete partitions. No false all-open snapshot replaced the cache during this incident.

CourtReserve's [official status page](https://status.courtreserve.com/) reported all systems operational and no October 31 incident when checked. That is consistent with an IP-specific restriction, but a status page alone cannot establish its scope or cause. The phone Wi-Fi/cellular comparison is the stronger evidence.

## Monitoring gaps found

- Docker's health check covered only local HTTP/storage readiness; green container health did not mean collection was fresh.
- Logs contained startup messages only. SQLite retained date checks and safe generic errors, allowing a timeline but not historical HTTP/CORS diagnosis.
- Browser CORS failures hid the upstream 429 from the normal Playwright Response event; the connector collapsed that into unavailable instead of honoring the actual rate-limit response.
- Reconnect detection was tied to provider retry timing, so a long backoff delayed noticing updated session files. Reconnecting cannot fix an IP rate limit in any case.
- Browser contexts remained alive between cycles, leaving possible page activity outside the measured scan window. Such idle traffic was not recorded, so its actual contribution is unknown.

## Changes

- Structured, redacted refresh-start/finish/failure/session-change events and bounded Docker log rotation.
- Durable seven-day refresh-run history with stage, HTTP/network classification, counts, timing, completion, and interruption records; legacy date checks remain readable. No tokens, request URLs, raw authenticated bodies, or player details are logged.
- Dashboard **Refresh activity & diagnostics**, `make status`, `make logs`, `GET /api/diagnostics`, and a separate `/health/collection` endpoint that returns 503 for degraded collection while process readiness can remain 200. No external alert-notification service is configured.
- One bounded confirmation GET for a failed schedule request when CORS hides its response; confirmed 429 honors Retry-After. Failed or malformed data still cannot publish Reserve controls as fresh availability.
- The initial reduction to 15-minute polling and closed idle provider contexts did not prevent the repeat 429. Collection now defaults to locally paused (`COLLECTION_ENABLED=false`) while the dashboard serves cached data; enable only after the provider confirms acceptable cadence/limits.
- Persisted cooldown imported from the observed 429, without another provider call or a cache rewrite. Operator probe commands refuse known active cooldowns.
- Bounded collection deadline with failure/interruption history and quarantine of an unsafe hung collector until restart; late callbacks cannot refresh cached data.

## Verification and review

Final `make verify` passed **63 tests**, type checks, formatting, and production build; dependency audit found no known vulnerabilities. Tests cover explicit and CORS-hidden 429 rejection, production replay URL/method/failed-request/header/redirect restrictions, immediate durable cooldown before a hung collector, subsequent probe/service deferral after a probe discovers a new 429, and non-shortening deadlines.

Actual Docker-served diagnostics showed the source as rate limited, cached data as not fresh, service readiness HTTP 200 and collection health HTTP 503. Manual refresh was deferred without a provider request. Docker restart preserved cache/settings and the exact retry deadline; all subsequent checks were local-only. Fresh review findings were fixed and re-reviewed with no actionable findings remaining. Provider recovery is still unverified and will not be probed early.

## Recovery

Use the dashboard diagnostics or `make status` to see the current pause and recorded not-before time. Do not reconnect, force refresh, run a live probe, or enable `COLLECTION_ENABLED` while waiting for provider guidance. The local dashboard continues serving clearly stale cached data. Normal cellular browsing remains separate from the blocked home-network path; the collector is not moved to another IP to evade the limit.

If home-network schedule access still fails after the provider's deadline, CourtReserve/McCarren support can investigate or unblock the IP and advise an acceptable read integration/cadence. Do not treat a subsequent successful login or a rendered Reserve grid as proof that schedule-data access recovered.
