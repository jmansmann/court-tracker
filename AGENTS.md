# Court Tracker

Personal, read-only tennis availability dashboard. Follow the workspace instructions in `/Users/jmansmann/development/AGENTS.md` and the project-specific guidance below.

## Start here

1. Read `docs/implementation-plan.md` for approved product scope, architecture, connector strategy, and milestone acceptance criteria.
2. Read `docs/execution.md` for the current run's objective, starting state, and resume checkpoint.
3. Inspect actual files, available tooling, and Git status if the project has become a repository. Preserve existing user work. As of the initial checkpoint, this directory is not a Git repository.

The original `docs/handoff.md` is research background. The implementation plan records the subsequent interview decisions. Check current provider behavior instead of treating either document as proof of a working connector.

## Product invariants

- Keep booking external. Connectors read schedules and may authenticate; they never reserve, hold, pay for, cancel, or modify courts.
- McCarren indoor is the first indoor priority: CourtReserve organization `10243`. USTA uses a separate organization, `5881`.
- Inspect real browser traffic and reproduce verified schedule requests where reliable. Browser-assisted requests, network response capture, and full Playwright DOM extraction are first-class options. A missing documented API does not establish infeasibility.
- Use New York local dates and `America/New_York`; persist/transport instants in UTC. Preserve native slot semantics and verified coverage.
- Keep explicit availability, booking-window coverage, and source health separate. Partial/error responses cannot erase or refresh an authoritative cached partition.
- Walk-on courts are static backups with unknown live availability. Sample/demo data must be unmistakably labeled and separate from live observations.
- Optional price/surface/eligibility/neighborhood data may be unknown. Never infer missing prices, membership, physical court identity, or bookable durations.
- Scraping permission is established in the handoff. Configure known provider constraints, measured request budgets, backoff, and nonoverlapping checks.

## Agent ownership and delegation

- The parent owns architecture, shared contracts, milestone status, integration, verification, and the final report.
- Use bounded workers when acceptance criteria and write scopes are clear. Delegate substantial source investigation to explore/research roles. Prefer at most two independent children at once; child agents do not delegate.
- Establish shared contracts and module ownership before parallel writers begin. Include absolute work directory, relevant instructions, scope, dependencies, checks, and expected concise results in every handoff.
- Obtain a fresh read-only review after a coherent behavior-changing slice is integrated and checked. Supply the starting state and readable actual changes/new files. Fix material findings before completion. Docs-only changes receive direct inspection.
- Continue routine implementation decisions using the approved plan. Record account/tooling blockers and proceed with independent authorized work. Escalate material scope or architecture changes; do not silently replace the prioritized indoor venue.

## Verification and durable progress

- Prefer the documented Make targets once bootstrap provides them. `make verify` is the quality gate; it must run substantive checks, not be a placeholder.
- Validate browser behavior with a real browser when implementing the UI or provider navigation. Distinguish a successful build, controlled-fixture tests, and an authenticated live-provider comparison in reports.
- A source is live-verified only after comparing actual extracted results with its normal visible schedule. Implemented adapters, fixtures, and public login shells do not establish live coverage.
- At coherent checkpoints, update `docs/execution.md` with changed paths, exact commands/results, review findings, blockers, and the next action. Keep secrets and authenticated raw traffic out of these notes.
- Before context runs out, save a concise resumable checkpoint. A fresh session reads that checkpoint and inspects actual state before continuing.

## Local operation

- Keep application state and browser sessions in protected, ignored local storage. Do not reuse or inspect unrelated browser profiles or secrets.
- Keep host-facing ports on loopback; package the app for Docker with tested browser dependencies and persistent state.
- Make failures explicit: missing login, stale data, unavailable Docker/browser tooling, and skipped live checks are reported independently.
- Keep changes unstaged. Do not initialize Git, stage, commit, push, or rewrite history unless Jimmy explicitly requests the applicable action. Leave unrelated repositories alone.
