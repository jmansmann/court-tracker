# Agentic Implementation Kickoff and Resume Checkpoint

**Updated:** 2026-11-01.
**Current state:** McCarren dashboard is running with cached data and improved diagnostics. Home-network CourtReserve schedule access returned a second Cloudflare 429 after 11 successful 15-minute cycles (119 recognized reads including the failed partial scan). The latest effective not-before deadline is **2026-11-02 13:55:41.121 UTC / 08:55:41.121 EST**. Collection is now disabled by default; the local dashboard/cache remains available and will not retry automatically at that time. No recovery or current live availability is claimed. Other sources remain deferred. See the incident checkpoint below.
**Owning plan:** [implementation-plan.md](implementation-plan.md).

## Recommended first run

Give one parent agent a bounded outcome: **a runnable local calendar with a real source where access is available, durable source status, Docker packaging, and verified core behavior**. The parent delegates bounded work and integrates it in this workspace. Keep the active agent session and computer running while the work proceeds.

The first run targets M0/M1 plus the independent NYC Parks portion of M2. It does not assume accounts for the remaining providers. The execution modes below let Jimmy decide whether to spend time on login before resting.

### Mode A — McCarren login available

1. Inspect prerequisites and bootstrap only enough tooling to launch the local interactive connect helper.
2. Jimmy signs into McCarren in the helper's browser. Verify access to organization `10243`; keep the resulting session only in protected local storage.
3. Complete M0: inspect normal schedule traffic, reproduce read requests, evaluate browser-backed extraction, establish slot/coverage semantics, and validate runtime/session reuse.
4. Build and verify the M1 end-to-end McCarren calendar. Add the public NYC Parks baseline if independent work and checks permit.

An existing login in Jimmy's ordinary browser does not automatically provide the agent a reusable session. The connect helper does not exist at the initial checkpoint; creating it is implementation work, not a command Jimmy can already run.

### Mode B — Jimmy steps away immediately

1. Inspect tooling and attempt public McCarren discovery without assuming authenticated access. Record any login dependency precisely.
2. Build the source-independent M1 foundation: workspace, validated provisional contracts, SQLite migrations, service, scheduler, UI, local connect helper, Docker packaging, and substantive verification targets.
3. Implement the already-approved public NYC Parks source as the real-data baseline. Compare extracted results with the public schedule and expose verified freshness/coverage. Availability may be empty or out of season; represent the observed state faithfully.
4. Keep McCarren prominently pending login. Test source-independent behavior with controlled fixtures and clearly distinguish that evidence from live verification. Defer provider-specific assumptions until authenticated M0 inspection.
5. When Jimmy returns, connect McCarren, complete M0, and adapt provisional contracts as necessary before claiming the McCarren slice complete.

Mode B explicitly permits the Parks baseline while McCarren is blocked. McCarren remains the first indoor priority. Public-source progress does not satisfy the authenticated McCarren acceptance criteria.

## Work breakdown and ownership

The parent checks environment and establishes the initial contracts and package skeleton. It then assigns work only where the module boundaries are stable enough for independent changes.

| Lane | Owner / useful delegation | Expected result |
|---|---|---|
| Shared contracts, migrations, scheduler/API integration | Parent | A small stable foundation with explicit coverage and health semantics |
| Source discovery and connector | Parent initially; bounded worker/research child after scope is clear | Evidence-based transport, sanitized fixtures, normalized real observations |
| Calendar and source-status UI | Worker after API/fixture contract is established | Seven-day/day comparison, duration filter, detail link-out, explicit pending/stale states |
| Integration and packaging | Parent | Local startup, protected persistent state, Docker/browser runtime, README and Make targets |
| Coherent-slice review | Fresh read-only reviewer | Findings against original requirements and actual scoped artifacts, followed by parent fixes |

Use at most two independent children at once by default. Workers receive disjoint write scopes. A reviewer runs after integration and checks; it is not a substitute for those checks.

## First-run completion evidence

- Documented commands start the local app, with the host-facing service bound to loopback.
- `make verify` passes formatting/lint, type checks, meaningful tests, and the production build.
- A real browser check covers the calendar, duration filtering, details/link-out, and pending/stale/error presentation.
- At least one available real source has a documented comparison with its normal schedule, or the exact external/tooling blocker is reported with the corresponding acceptance item still pending.
- Docker build/start/restart and browser/session handoff are tested where supported; failures and skipped checks are explicit rather than reported as passing.
- A refresh still runs after the dashboard tab closes; restart preserves settings/cache and correctly labels aged observations.
- A fresh reviewer inspects the coherent implementation, including parent-written changes and new files; material findings are fixed.
- The checkpoint below contains exact results, changed paths, review outcome, remaining blockers, and the next command/action.

Keep UI screenshots, if useful, as local check artifacts; never include session state or authenticated raw network captures in checked-in documentation.

## Handling interruptions and blockers

- Missing login/MFA blocks that source. Record the required user action and continue independent work covered by the chosen mode.
- Unsupported undocumented requests trigger browser-assisted/network/DOM investigation as described in the plan. Judge infeasibility from evidence.
- A missing Docker daemon may still permit native development and checks; leave Docker acceptance pending with its actual failure. Do not install system services or change unrelated machine configuration to conceal the blocker.
- After a failed check, investigate and fix the cause, then rerun the relevant checks. Record unresolved environmental failures separately.
- Finish when the assigned slice is verified or all remaining work requires external input. Save a checkpoint before ending or resuming in a fresh context.

An agent run progresses only while its harness/session is executing. This document supports explicit continuation after interruption; it does not create an unattended background orchestrator.

## Kickoff prompt

Use the following in this project, choosing `A` or `B`:

```text
Start implementation in /Users/jmansmann/development/court-tracker.
Follow the workspace and project AGENTS.md, docs/implementation-plan.md,
and docs/execution.md. Execute the recommended first run in Mode [A or B].

Own the result end to end. Delegate bounded, disjoint work when useful;
make routine evidence-backed decisions without waiting for me. Continue
independent work if a provider needs login, keeping live-source claims accurate.

Deliver the runnable local slice, meaningful make verify checks, real-browser
verification, Docker checks where available, and one fresh coherent-feature
review. Fix material findings and leave all changes unstaged. Do not initialize
Git, stage, commit, push, or change unrelated projects.

Keep docs/execution.md current at coherent checkpoints. At the end, report
exact startup commands, implemented and live-verified coverage, checks and
review results, blockers, and the next action for me.
```

## Resume checkpoint

### Starting state

- This directory contains `AGENTS.md` and `docs/`; it is not a Git repository.
- Existing `docs/handoff.md` is the research handoff; `docs/implementation-plan.md` contains the approved direction and defaults.
- `AGENTS.md` and this execution brief were added to prepare the agentic kickoff.
- No application source, package manifest, Makefile, Docker configuration, provider session, or runnable connect command exists yet.
- No implementation tests, browser probes, authenticated checks, or Docker checks have run.

### 2026-10-31 — first implementation slice

**Requested outcome:** Start the scoped project by validating Jimmy's McCarren login and testing actual read-only schedule retrieval. Executed the initial account-enabled Mode A feasibility slice, not the full recommended M0/M1/Parks run.

**Starting state confirmed:** `git status --short` returned `fatal: not a git repository`; only existing `AGENTS.md` and the three documentation files were present. No Git repository was initialized; existing planning/research material was preserved.

**Changed paths:** New `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.gitignore`, `.prettierignore`, `tsconfig.json`, `Makefile`, `README.md`; `scripts/mccarren.ts`; `scripts/lib/local-state.ts`, `scripts/lib/mccarren-data.ts`, `scripts/lib/mccarren-browser.ts`, each with tests; `docs/sources/mccarren.md`. Updated plan status and this checkpoint. Protected ignored `.local/mccarren/` contains cookies and sanitized operational reports, never documentation fixtures.

**Implemented:** Pinned pnpm/TypeScript/Playwright probe, explicit browser install, normal interactive login with a separate Save session tab, protected cookie-only persistence, fresh-context reuse, signed-in organization validation, one observed schedule GET replay per date, validated native start markers with New York/UTC handling, bounded next-day navigation, partial-coverage labels, safe errors/latest-attempt status, and storage/payload/DST regression checks.

**Live evidence:** Jimmy signed in and saved the session. Final post-review `make test-live` at 04:47 UTC read 2026-10-31 and 2026-11-01; structured responses had 83 and 85 entries, and visible calendars had 15 and 28 Reserve markers respectively. Both observed schedule request replays returned HTTP 200 with matching scheduling projections. This run took 4.4 seconds, four recognized browser bootstrap/schedule reads plus two replay reads. Full details and limitations: [sources/mccarren.md](sources/mccarren.md).

**Checks and review:**

- `make browser` — matching Playwright Chromium installed successfully.
- `corepack pnpm install --ignore-scripts` — pinned project dependencies installed; lifecycle scripts disabled.
- `make test-live` — authenticated two-date headed comparison passed as above.
- `node scripts/mccarren.ts test-live --headless --days=1` — failed explicitly: Cloudflare blocked the browser; the last successful report was preserved. Public headless access was also blocked; public headed access reached the normal login page. The final headed retest restored latest-attempt success; browser-mode-specific diagnosis remains documented here.
- `make verify` — passed formatting, TypeScript checking, **24 tests** including controlled real-browser readiness cases, and compilation. An initial `pnpm` shim issue was fixed by invoking pinned pnpm via Corepack throughout; a subsequent DOM iterable type error was fixed using `Array.from` before the final passing gate.
- `corepack pnpm audit` — no known vulnerabilities.
- `make install` — frozen-lockfile, lifecycle-scripts-disabled install passed.
- Fresh read-only review found two material edge cases: provisional/old controls could be accepted during rendering, and failed replay could still publish overall success. Both were fixed; loading-signal and replay-gate regression tests were added. The reviewer re-read the actual integrated corrections and reported both resolved, with no actionable findings. Final `make verify` and authenticated two-date rerun passed after integration. Failure-status publication was inspected by the reviewer but is not covered by an end-to-end CLI failure test.

**Current blockers and next action:**

- Login is available and cookie reuse works locally in headed Chromium. No password or OTP is needed in chat.
- M0 remains open: complete-day scrolling/coverage, native duration/price/eligibility/release semantics, true empty state, session lifecycle, complete seven-day budget, and Docker/browser session handoff. Docker's daemon is available; container behavior has not been tested. Headless Cloudflare rejection must inform the runtime choice.
- M1 (service/UI/cache/scheduler/Compose) and public NYC Parks work have not started.
- Next command: `make test-live` from this project directory, or `make connect` first if the saved session expires. Then complete the remaining M0 evidence before committing to production connector semantics and the end-to-end dashboard.

### 2026-10-31 — McCarren local calendar vertical slice (latest checkpoint)

**User direction:** Proceed with the next building step for McCarren; connect all other sources later. This run intentionally excluded Parks and other indoor providers.

**Starting state:** The previously verified two-date M0 probe, root pnpm/tooling files, `scripts/lib` helpers/tests, protected provider cookies, and planning/source docs were present. `git status --short` still returned `fatal: not a git repository`; no repository was initialized, staged, or committed. Existing local provider state was consumed programmatically without printing it.

**Implemented and changed paths:**

- `packages/contracts/src/index.ts`: validated observations, complete/failed partitions, preferences, source status, API responses, and New York date helpers.
- `packages/connectors/src/mccarren.ts`, `session.ts`, `mccarren.test.ts`: reusable headed context; normal Today reset/Next navigation; eight-date full-grid collection; safe failures, cancellation, cookie-only session reuse, and controlled orchestration regressions.
- Expanded `scripts/lib/mccarren-browser.ts`/tests and `mccarren-data.ts`/tests: validated source bounds; all court/time body cells verified through scrolling, date/loading guards, terminal-day handling, independent native-label counts, and rejection of missing/clipped/changed grids. Original private JSON storage and legacy two-date CLI remain intact.
- `apps/service/src/{http,main,store,scheduler}.ts` and tests: same-origin loopback Fastify API, exact built-asset allowlist, SQLite migrations/WAL, atomic per-date replacement, stale/error preservation, preferences, 120-second default background cadence, coalescing/backoff, persisted login/block pauses, and reconnect detection from private file metadata.
- `apps/web/`: React/Vite calendar with week/day navigation, duration/observed-court filters, grouped week starts with every court individually selectable in details, separate mobile/day starts, unknown metadata, per-date health/freshness, polling, safe external booking links, and browser regression checks. Preference hydration/generation guards prevent old polls from reverting saved filters.
- `scripts/collect.ts`, `check-app.ts`, `check-restart.ts`: opt-in full live collection and explicit application/runtime acceptance checks. No demo fallback is shipped.
- `Dockerfile`, `.dockerignore`, `compose.yaml`, root manifest/lock/tsconfig/Makefile, README, `docs/api.md`, source findings, plan status, and this checkpoint. `.local/` and `dist/` are ignored; local state is excluded from image builds.

**Live provider evidence:**

- Full eight-date collection at 05:21 UTC and final stricter-body-coverage rerun at **05:44:47 UTC** both passed. Dates Oct 31–Nov 7 had **45, 45, 20, 18, 21, 12, 22, 49** native Reserve start choices (**232 total**), all seven courts and all configured 06:00–23:59 source rows, three viewports/date. Final run: **19.8 seconds, ten recognized provider reads**. Both date boundaries and the Nov 1 DST shift were checked; terminal Nov 7 disables Next.
- The first container reused host login cookies and refreshed successfully at 05:23:46 UTC. A later reused-context failure exposed CourtReserve remembering its terminal viewed date; the normal Today-reset correction restored complete background refreshes at 05:28:23 and **05:30:42 UTC**, with no dashboard tab open. The failure retained all prior complete partitions and their original timestamps.
- The actual seven-day calendar displayed **183 native choices**. The eighth cached date is available by navigating forward. Prices/durations/eligibility remain unknown; separate half-hour starts are never merged into invented bookable intervals.

**Final checks:**

- `make verify` — **passed** formatting, TypeScript, **51 tests**, and production compilation/Vite build after all behavior corrections. Tests cover payload/session storage, DST, complete/empty/partial/delayed/terminal/missing-body/clipped grids, actual connector date/reset/cancellation orchestration with fully routed fixtures, SQLite atomicity/pruning/restart, scheduler non-overlap/backoff/persisted pauses, API input/Host/origin/static-file safeguards, and UI filtering/groups/details/errors/polling preference races.
- `corepack pnpm audit` — **no known vulnerabilities**. An initial static-file plugin introduced two moderate glob/minimatch advisories; it was removed in favor of an exact emitted-asset allowlist with traversal/symlink regression coverage.
- `make install` — frozen-lockfile, lifecycle-scripts-disabled install passed. Browser installation remains explicit.
- `node scripts/collect.ts` — final authenticated eight-date/full-grid check passed as above. Do not run it alongside the running service.
- `make up` — Docker image rebuilt, compatible Chromium/dependencies/Xvfb installed, health check passed, loopback-only `127.0.0.1:4317` publishing confirmed. The final app remains running in Compose.
- `node scripts/check-app.ts` — actual Docker-served UI passed: fresh complete seven-day cache/183 starts, grouped-choice accounting, week/day interaction, details/safe link/Escape, narrow-screen layout, **zero console/page errors**. Live and controlled screenshots were inspected; they remain temporary local artifacts.
- `node scripts/check-restart.ts` — actual Docker restart passed: seven complete partitions/183 starts and nondefault day view, 90-minute filter, unknown-duration preference survived; the original preferences were restored afterward.
- Final `docker compose ps` reported healthy with only `127.0.0.1:4317` published. `/api/sources` reported a complete healthy automatic refresh at **05:50:15 UTC**, confirming the final rebuilt/restarted runtime continued collecting successfully.
- Fresh read-only feature review found restart-lost login pauses and a polling/preference race. Both were fixed with regressions. It also identified a completeness-evidence gap; actual per-court background body-cell checks and missing-body/clipped-empty tests were added and live-reverified. Focused re-review reported **both P2s resolved, no actionable findings**, and the completeness/orchestration gaps substantially addressed. The reviewer did not execute checks; it inspected actual scoped files. Exact original-file deltas cannot be independently reconstructed because this directory has no Git baseline.

**Remaining limitations:** Native supported reservation durations, prices, account eligibility, exact booking release time, and long-duration session behavior are not established; the app explicitly labels unknowns. No entirely empty natural live date was encountered; true empty grids are controlled-fixture verified. The cancellation test verifies failure-only publication but does not independently assert resource closure before its final cleanup; graceful real Docker stop/restart succeeded. Sustained request/resource behavior beyond these bounded runs still needs observation. No other provider was connected.

**Operating/next action:** Open **http://127.0.0.1:4317**. `make down` stops the current Docker app without deleting state; `make up` starts it again. `make connect` on the host renews a session and is detected on a subsequent metadata check. `make dev` is the native alternative; run one runtime at a time. The next useful step is user feedback on the McCarren calendar and observation of session/release behavior, followed by other providers only when requested.

### 2026-10-31 — Rate-limit incident and monitoring (latest checkpoint)

**Request:** Investigate refresh stopping hours earlier, provide monitoring/logging, and determine whether the provider's all-open website reflected damaged data or an access failure. Jimmy explicitly requested one retry during investigation.

**Starting state:** The previous 51-test local vertical slice remained non-Git (`git status --short` failed; no repository was initialized or staged). Docker was up seven hours and healthy according to local HTTP/storage readiness. Logs contained startup lines only. Read-only SQLite history showed last full eight-date success at **06:13:23 UTC / 02:13 EDT**; a partial check failed at 06:16, then unavailable errors continued with backoff up to one hour. All complete cached partitions and success timestamps were preserved.

**Confirmed evidence:** A bounded headed browser probe at 12:46 UTC confirmed valid login/organization membership and configuration (HTTP 200), but the schedule Fetch failed with CORS/`net::ERR_FAILED`; replay of the observed read returned 429 despite visible Reserve controls. Jimmy confirmed the same phone showed real bookings on cellular and lost them on home Wi-Fi. His requested retry at **13:08:59.153 UTC** confirmed **Cloudflare HTTP 429** and **Retry-After 61,599 seconds**. Persisted not-before time: **2026-11-01T06:15:38.153Z**, about **Sunday 1:15 a.m. EST after the clock change**. This identifies home-network/IP access limiting, not erased reservation data. The original two-minute polling may have contributed; the exact triggering request was not logged, so causality is not proven retrospectively. CourtReserve's public status page showed no general incident.

**Behavior and monitoring changes:**

- Shared contracts now carry allowlisted failure diagnostics and bounded refresh-run/date-check history. `ScheduleStore` migration v3 preserves existing cache/preferences/status and adds seven-day run history plus independent provider not-before metadata.
- Scheduler logs structured start/finish/failure/session-change events, persists run history and interruption outcomes, watches session metadata separately, honors cooldowns across restart/reconnect/session-file deletion, and bounds/quarantines hung collection without accepting late callbacks. Known 429 deadlines are persisted **before other failure publication or browser cleanup**, so a hang/crash cannot discard an already observed limit. Metadata extension is transactional and never shortens a deadline.
- Connector classifies readable and CORS-hidden 429s with one bounded confirmation GET. Both production and operator inspection share the exact failed-read validator: HTTPS backend member-expanded, organization/date/timezone, GET, failed browser request, allowlisted headers, no redirects. HTTP or malformed API failures cannot publish the site's Reserve placeholders as availability. Provider browsers now close between cycles to avoid idle traffic; `keepOpen` remains an explicit controlled-test option.
- Default/minimum runtime cadence is **900 seconds**, not 120. Reconnect/manual refresh/restart and live CLI commands cannot override a provider Retry-After. New 429s observed by standalone collection, inspection, or legacy probes durably update the same budget immediately without changing availability success timestamps.
- Added `GET /api/diagnostics`, `/health/collection` (503 when degraded), `make status`, `make logs`, structured/rotated Docker logs, a prominent cached-data banner, and the expandable **Refresh activity & diagnostics** panel. Service readiness can remain 200/healthy while collection is degraded. No external notification integration was configured.
- Added local-only `scripts/check-monitoring.ts`, guarded `scripts/inspect-provider.ts`, `scripts/status.ts`, and a local-only rate-limit observation importer. The two actual diagnostic observations were imported as explicitly labeled one-off events; historical unavailable checks were not assigned invented HTTP details.

**Paths:** Updated contracts, connector/tests plus `failed-read.test.ts`, service store/scheduler/http/main and tests/new diagnostics module, web App/new DiagnosticsPanel/styles/browser tests, compose logging/defaults, Make targets, CLI budget/inspection/status helpers and tests, README/API/source docs, and `docs/incidents/2026-10-31-mccarren-rate-limit.md`. Existing private session cookies were consumed programmatically only; none were printed or committed. `.local/` stores protected state and is still excluded from source/image builds.

**Final checks:**

- `make verify` — **passed: 63 tests**, formatting, TypeScript, and production build. New regressions cover v2→v3 preservation, run-history privacy/bounds/pruning, CORS-hidden/readable 429 rejection, exact production replay restrictions, watchdog-after-429/restart protection, fresh probe-observed cooldown persistence, missing/replaced sessions, manual deferral, monitoring health/API privacy, and diagnostics UI behavior. A test-only ISO-format comparison and nested test placement were corrected before this final pass.
- `corepack pnpm audit` — no known vulnerabilities. Earlier frozen install passed; dependencies/lockfile were unchanged by this incident work.
- `make up` — rebuilt image and healthy local readiness. Runtime remains running at **http://127.0.0.1:4317** with cadence 900 and the persisted provider deadline.
- `node scripts/check-monitoring.ts` — actual Docker UI/API passed: HTTP readiness 200 versus collection 503, visible HTTP 429, correct zoned retry time, local-only requests, narrow layout, and deferred manual refresh without any provider request or success-time change. Screenshot inspected locally.
- `node scripts/check-restart.ts` — actual Docker restart preserved all seven queried complete partitions, **168 still-future cached choices**, preferences (temporarily changed then restored), and the exact cooldown. The lower count versus 183 earlier is past-start filtering, not a fresh collection.
- Final Docker logs contained structured `service.started` events with `collectionHealth: rate-limited`, cadence 900, and the same next-due deadline; no fresh provider collection was triggered.
- Fresh read-only review found three material cooldown/replay gaps. They were fixed: persist 429 before a hung collector can finalize, persist newly observed operator 429s automatically, and restrict inspector replay to the validated failed schedule read. Re-review reported **all three resolved and no actionable findings**. Reviewer inspected code/tests but did not run checks; exact before/after delta attribution remains limited by the non-Git starting state. Production confirmation logic is directly tested through a fake HTTP interface; actual provider recovery was deliberately not attempted after the long Retry-After.

**Next action / constraints:** Use the dashboard panel, `make status`, or `make logs`. The provider's first permitted retry is about **November 1, 1:15 a.m. EST**; neither a login success nor an all-open drawn grid proves recovery. No additional provider probes were made after the 13:08 response. Avoid force/reconnect/probe loops. If access remains blocked after the deadline, contact CourtReserve/McCarren about the IP restriction and an approved integration/cadence; do not move the collector to another IP to evade the limit. Stale cached data remains explicitly labeled. Other provider work is still deferred.

### 2026-11-01 — Court Tracker identity and interactive architecture map

**Request:** Rename the local project to match `court-tracker` / `https://github.com/jmansmann/court-tracker`, then build a locally hosted, interactive architecture diagram using the `architecture-diagram` skill.

**Starting state:** The project directory was `/Users/jmansmann/development/nyc-tennis-availability`, with the prior written architecture guide present and no `.git` directory. The GitHub URL was provided, but the working copy was not initialized or connected to a remote. The previous Docker container was running on `127.0.0.1:4317`; the persisted provider cooldown had expired by the time the project was rebuilt.

**Implemented:**

- Renamed the project directory to `/Users/jmansmann/development/court-tracker`, changed the root package name to `court-tracker`, updated project/document titles and the reusable execution prompt, and refreshed pnpm's workspace metadata. Current project references use the new identity; the prior path appears only in this checkpoint's starting-state record.
- Added `docs/architecture.html` from the global architecture-diagram skill template and `docs/architecture-diagram.md` as its standalone companion. The diagram has four click-through flows: calendar read, background collection, session connection, and manual refresh. It is served at `/architecture`, is linked from the dashboard footer and README, and makes no API/provider requests or external asset requests itself.
- Added a narrowly scoped CSP for the self-contained diagram route, while keeping it local-only; other service routes retain the existing policy. The written code tour in `docs/architecture.md` links to the interactive version.
- Replaced the old Compose project/container with `court-tracker-calendar-1`, preserving `.local/` and port `127.0.0.1:4317`.

**Verification:**

- `make verify` — passed formatting, TypeScript, **63 tests**, and production compilation/Vite build.
- Architecture skill static check — **`static checks OK`** (no placeholders, syntax errors, flow/tab mismatch, or unknown node IDs).
- Playwright Chromium against the locally served route — all four flows and their steps navigated; `window.archValidate()` returned `[]`; no console/page errors or external requests. Desktop and 390px mobile captures were inspected; the page has no document-level horizontal overflow (the diagram canvas scrolls internally on narrow screens). The dashboard footer link opened `/architecture`.
- Docker Compose rebuilt and reported healthy on loopback. `/api/sources` reports the saved provider cooldown; the new service start logged `collectionHealth: rate-limited` and the persisted next-due time. The normal scheduled attempt at **13:55 UTC** was made by the old container after its prior Retry-After had expired and received another HTTP 429. The new container started at **14:05 UTC**; architecture-page verification itself made no provider request.

**State at this checkpoint:** Open **http://127.0.0.1:4317/architecture** (or click “Explore the architecture” in the dashboard footer). The latest source status reported a repeated 429; cached data remains stale until a complete collection succeeds. At this checkpoint the local directory had no `.git` metadata; Jimmy subsequently initialized the local repository and connected `origin`. See the next checkpoint for current Git and pre-commit audit status.

### 2026-11-01 — Pre-commit secret and remote-readiness audit

**Request:** Check the Court Tracker working copy for secrets and verify that the intended project contents are ready for Jimmy to commit and push.

**Git/remote state:** The local `main` branch tracks `origin/main` at `0aef759` (`first commit`); `git ls-remote origin HEAD refs/heads/main` returned the same commit for both refs. The remote commit currently tracks only `README.md`. The README duplicate trailing `# court-tracker` heading was removed because it caused the formatting gate to fail. Current project files remain unstaged/untracked except for that README deletion; no stage, commit, or push was made. `.local/`, `node_modules/`, and `dist/` are ignored.

**Secret scan and data boundaries:** Redacted Gitleaks scans found **no leaks** in the existing Git history, `apps/`, `packages/`, `scripts/`, `docs/`, either architecture file, or the root manifest/build/config files. No `.env*` or key/certificate files are present among commit candidates. The local `.local/mccarren/session.json` is an intentional provider-cookie credential; `.gitignore` excludes all of `.local/`, and `.dockerignore` excludes it from the image build. The session contents were not read or printed. `git check-ignore -v` confirmed the session, sanitized live reports, SQLite database/WAL files, `node_modules`, and `dist` are ignored.

**Quality/supply-chain checks:** `corepack pnpm audit --audit-level=high` reported no known vulnerabilities. A final `make verify` passed formatting, TypeScript, **63 tests**, and the production build. Its first attempt exposed a date-dependent DST test fixture that relied on Luxon's ambiguous local-time default; the isolated test reproduced it, and the fixture now specifies the two explicit UTC instants for the repeated 01:30 hour. `git diff --check` and `git diff --cached --check` are clean. The Gitleaks scanner and reports were run without adding files or dependencies to the project.

**Current readiness:** `origin` is the expected Court Tracker URL and the remote is reachable/readable. There are no detected secrets in the existing commit or intended project source; the only credential-bearing files are under ignored `.local/`. All project files are ready for review and staging. Docker Compose remains healthy on loopback. The provider is still rate-limited until the persisted next-due time; no live-provider request was made as part of this audit.

### 2026-11-01 — Place service modules under the service source tree

**Request:** Keep `scripts/` for one-off operator commands and put application production modules under the service's source tree instead of presenting them as separate packages.

**Structure changes:**

- Moved `local-state.ts` and its tests to `apps/service/src/`; service code, connector sessions, and operator scripts import that internal service module.
- Moved the McCarren connector, session, browser-grid/payload helpers, and their tests to `apps/service/src/connectors/`. The one-off CLI commands import the same service connector code.
- Kept `scripts/lib/provider-budget.ts` and its test under `scripts/lib/`; its consumers are operator commands, not the application runtime.
- Kept `packages/contracts/` as the shared contract source for the web, service, and scripts. Updated the root-resolution test paths and architecture/plan documentation. The root TypeScript project still compiles all areas together; none are separate installable packages.

**Verification:** `make verify` passed formatting, TypeScript, **66 tests**, and the production build. Docker Compose rebuilt from the new source tree; its first recreate reported a transient container-name conflict, then the replacement container was confirmed healthy with the relocated compiled files present. A subsequent `docker compose up -d --wait --wait-timeout 60` succeeded. `/health/ready` and `/architecture` returned HTTP 200. Playwright confirmed the four diagram flows still validate with no browser errors or external requests. No provider/live request was made.

**Review:** A read-only review of the preceding packages-based layout reported no actionable findings, but it predates the final move into `apps/service/src/`. A second review was unavailable; the final path changes were directly inspected and verified with the full test/build gate.

**Current state:** `apps/service/src/connectors/` contains the McCarren adapter and its implementation helpers; `packages/` contains only shared contracts; `scripts/lib/` contains only the operator-only provider-budget helper and test. The local service remains on loopback with collection paused by the persisted rate-limit deadline (**2026-11-02T13:55:41.121Z**). Changes remain unstaged; no commit or push was made.

### 2026-11-01 — Structural audit and operator-tool cleanup

**Request:** Audit the project layout before the initial application commit, then use cheaper Luna workers to implement the recommended targeted cleanup under parent direction.

**Starting state:** `README.md` was modified and the remaining source, tooling, and documentation were untracked. Existing project work was preserved. A complete pre-task script-source diff was saved outside the repository for review; ignored local state and credentials were not included.

**Accepted scope:** Keep `apps/service/src/`, `apps/web/src/`, and `packages/contracts/src/` as logical boundaries within one root Node package. Give CLI provider-access operations a backend owner, reuse the backend session implementation, and distinguish supported commands from diagnostics, acceptance checks, and incident maintenance. Separate build/type-check configurations remain a follow-up.

**Implemented:** Two explicitly selected `openrouter/openai/gpt-6-luna` worker sessions handled disjoint backend-policy and script/session scopes. Provider permission checks and observed-rate-limit recording, with their four regression tests, moved to `apps/service/src/provider-access.ts` and its colocated test. `scripts/connect.ts` now owns interactive login and reuses `connectors/session.ts`; the legacy probe also reuses that session loader. A side-effect-free CLI response observer is shared under `scripts/diagnostics/`. Provider diagnostics, opt-in acceptance checks, and manual incident-state maintenance moved into their named script subdirectories. The parent removed the temporary provider-budget shim, completed script formatting/import cleanup, rewired package commands, and updated the current README/architecture/plan documentation. The script worker reached its 24-step limit after implementation; its remaining integration and checks were completed by the parent.

**Verification:** `make verify` passed formatting, TypeScript, **66 tests**, and the production build. Four disabled-provider CLI preflight checks passed for connect, collect, the legacy inspect command, and the provider inspector. They used `COLLECTION_ENABLED=false` and confirmed the existing refusal messages and per-command exit codes before provider/session access. The smoke harness initially assumed every refusal used exit 1; it was corrected to expect the pre-existing exit 2 for collect/inspector. `git diff --check` passed. Current command references resolve to the relocated files; old paths remain only in historical execution checkpoints. No provider requests, local credential reads, persistent application-state writes, or service/container restarts were performed by these checks.

**Review:** A fresh read-only Luna reviewer inspected both workers' source changes and the parent integration/documentation against the captured script baseline. It found one introduced CLI compatibility regression: the legacy `check-session` alias and its failed-test status recording had been dropped during extraction. Both branches were restored to their original behavior. The parent also retained the maintenance importer's existing instruction to run with the service stopped. The reviewer confirmed those corrections and reported no remaining issue in the corrected files; the initial review found no other actionable issues. Final `make verify` passed again after correction: formatting, TypeScript, all **66 tests**, and production build. The reviewer inspected artifacts but did not independently run checks.

**Current state / next action:** Structural cleanup is complete and changes remain unstaged for Jimmy's review. Supported Make commands retain their existing names; direct diagnostic/check paths are documented in the README. The running service and provider pause/cooldown state were not changed by this task. Review the resulting layout and source before staging the initial application commit.

### 2026-11-01 — Follow-up branch for interrupted 429 deadline diagnostics

**Request:** Continue the rate-limit investigation on a new branch after another session committed the initial pause/diagnostic work. The latest read-only review found that an interrupted refresh could retain a provider `Retry-After` in metadata while leaving `nextDueAt` null and changing health to `error`; the UI could then hide or mislabel the deadline.

**Starting state:** Clean `main`/`origin/main` at `6f18e35` (`inital commit for court-tracker app`). Created local branch `fix/mccarren-rate-limit-diagnostics`; no files were staged or committed on this branch.

**Changes on this branch:**

- `apps/service/src/scheduler.ts` and `packages/contracts/src/index.ts`: a deferred manual refresh while collection is paused returns the durable `providerNotBefore` as a separate optional response field, before the generic `nextDueAt`.
- `apps/web/src/App.tsx` and `apps/web/src/DiagnosticsPanel.tsx`: display the provider deadline whenever `providerNotBefore` exists, regardless of source health or local pause state; ordinary `nextDueAt` remains separately labeled.
- `apps/service/src/scheduler.test.ts`: restart regression seeds a persisted 429 deadline with an in-progress status, verifies recovery to `error`/paused with `nextDueAt: null`, confirms `providerNotBefore` survives, and checks manual deferral still includes the deadline.
- `apps/web/src/App.test.ts`: browser regressions verify a paused/error state with `providerNotBefore` and `nextDueAt: null` displays the exact provider deadline, and a refresh response can show that deadline before `/api/sources` loads.
- `docs/api.md` documents the optional `RefreshResponse.providerNotBefore` field; `scripts/checks/check-monitoring.ts` verifies the deferred response returns the same deadline without changing source timestamps or triggering a provider request.

**Verification:** `make verify` passed formatting, TypeScript, **66 tests**, and production build. `make up` kept the Docker service healthy with `collectionEnabled:false`. `node scripts/checks/check-monitoring.ts` reported `paused-monitoring-verified`, readiness 200, collection health 503, manual refresh deferred, and zero provider requests. `/api/diagnostics` still reports the unchanged `2026-11-02T13:55:41.121Z` provider not-before deadline; no provider request was made.

**Review:** The first fresh review identified the interrupted-429 UI deadline gap described above. The follow-up review found no remaining scheduler/UI/contract/test issue; its only documentation finding was that the checkpoint omitted `docs/api.md` and `scripts/checks/check-monitoring.ts`, now listed above. A final fresh review of the optional refresh-response deadline and the no-source-status UI path found no actionable findings. Reviewers inspected the supplied diff and source; they did not rerun the recorded checks, and no provider call was made.

**Current state / next action:** `fix/mccarren-rate-limit-diagnostics` contains the nine-file follow-up deadline-diagnostics change; working-tree changes remain unstaged and uncommitted. Leave the branch for Jimmy's review. Do not enable collection until McCarren/CourtReserve confirms an acceptable cadence.
