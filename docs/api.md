# Local McCarren API

Served on `http://127.0.0.1:4317`, with the built dashboard on the same origin. Runtime schemas/types are in `packages/contracts/src/index.ts`. Provider cookies, tokens, personal reservation details, and raw provider responses never appear in this API.

| Request                                    | Response                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /api/schedule?from=2026-10-31&days=7` | `ScheduleResponse`: revision, New York date range, source status, per-date coverage/freshness/observations, preferences |
| `GET /api/sources`                         | `{ sources: SourceStatus[] }`                                                                                           |
| `GET /api/diagnostics?limit=20`            | Source/collection freshness, bounded refresh-run records and prior date checks; limit 1–100                             |
| `GET /api/facilities`                      | Single McCarren indoor facility and external booking URL                                                                |
| `GET /api/preferences`                     | `Preferences`                                                                                                           |
| `PATCH /api/preferences`                   | Merged `Preferences`; accepts only view, durationMinutes, includeUnknownDuration, courtIds                              |
| `POST /api/refresh-requests` with `{}`     | HTTP 202, status `accepted`, `coalesced`, or `deferred`, and `nextDueAt`                                                |
| `GET /health/live`                         | Process health                                                                                                          |
| `GET /health/ready`                        | Storage readiness and revision; provider failures do not fail readiness                                                 |
| `GET /health/collection`                   | HTTP 200 while the last complete snapshot is within the freshness threshold; HTTP 503 when it is not fresh              |

Schedule requests default to today in `America/New_York` and seven days. Valid Gregorian date and 1–7 days are required; unknown query keys are rejected. Queries read SQLite only. Dates without cached coverage return `coverage: unknown`, never an inferred booked/empty day. The background collector independently watches today through seven days ahead, as validated against McCarren's terminal Next day control.

`SourceStatus.collectionPaused` reports the local `COLLECTION_ENABLED` setting. It is `true` when `COLLECTION_ENABLED` is unset or `false`; the calendar/cache API remains available, but scheduled and manual provider collection are disabled. `SourceStatus.providerNotBefore` preserves the provider cooldown separately from the ordinary `nextDueAt`, including if a later collection timeout changes source health. `POST /api/refresh-requests` returns `deferred` without contacting CourtReserve. Set `COLLECTION_ENABLED=true` only after the provider confirms an acceptable automated cadence; the service starts a provider check immediately when enabled.

The diagnostics collection status is `paused` while this flag is true. Freshness continues to reflect the age and health of the last complete provider snapshot; `/health/collection` can remain HTTP 200 until that snapshot crosses the stale threshold.

Every opening is a separate `reserve-start`, with UTC `startUtc` plus New York `localDate/localTime`, a provider court ID/label, observation time, and the allowlisted organization schedule URL. `durationMinutes`, `endUtc`, and `price` may be null; null never becomes zero or an inferred duration. Missing starts are not used to manufacture unavailable inventory.

Per-date `coverage` and `lastSuccessAt` describe the last authoritative complete snapshot. A later failure updates `lastAttemptAt/errorCode/message`, preserves that snapshot, and sets `isStale`. Data also becomes stale after `max(2 × cadence, 120 seconds)`. Past starts are omitted from query responses without changing the partition's recorded coverage.

`durationMinutes` preference accepts null, 30, 60, 90, or 120. Duration and court filtering are currently applied by the UI to validated cached observations. Unknown durations match a selected minimum only when `includeUnknownDuration` is explicitly enabled, and the UI labels that uncertainty.

Mutation routes require JSON and reject unknown fields. Browser requests must be same-origin with a local allowlisted Host; cross-site browser requests, foreign Origin headers, and DNS-rebinding Hosts are rejected. No CORS access is enabled. The service binds to loopback natively; Docker publishes only `127.0.0.1`.

Errors use `{ error: { code, message } }`, with 422 for invalid values, 403 for rejected origins/Hosts, 415 for non-JSON mutations, and a generic 500 without internal stack traces. Refresh requests are safe to repeat: they coalesce or defer under the collector's existing pause/cadence/backoff, rather than bypassing it. An HTTP success is distinct from successful provider collection; inspect source and per-date status.

Diagnostic records contain only allowlisted stage/kind/endpoint labels, HTTP status and sanitized network error codes, timestamps, date counts, request counts, and safe operational messages. Missing measurements remain unknown. Known `Retry-After` deadlines survive restart and reconnect; manual refresh remains deferred. The parsed delay is capped locally at 86,400 seconds. New refresh history is retained for seven days. Earlier checks lack request-level diagnostics and are not retroactively assigned a guessed HTTP cause.
