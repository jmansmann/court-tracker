import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DateTime } from "luxon";
import {
  BOOKING_URL,
  TIME_ZONE,
  dateRange,
  type CompletePartition,
  type Opening,
  type PartitionResult,
  type RefreshRun,
} from "../../../packages/contracts/src/index.ts";
import { ScheduleStore } from "./store.ts";

const DAY = "2026-11-01";

function opening(localDate: string, localTime: string, courtId = 11): Opening {
  const startUtc = DateTime.fromISO(`${localDate}T${localTime}`, {
    zone: TIME_ZONE,
  })
    .toUTC()
    .toISO()!;
  return {
    id: `${courtId}:${startUtc}`,
    sourceId: "mccarren",
    courtId,
    courtLabel: `Court ${courtId}`,
    localDate,
    localTime,
    startUtc,
    endUtc: null,
    kind: "reserve-start",
    providerLabel: "Reserve",
    durationMinutes: null,
    price: null,
    eligibility: "unknown",
    bookingUrl: BOOKING_URL,
    observedAt: "2026-10-31T12:00:00.000Z",
  };
}

function complete(
  localDate: string,
  openings: Opening[],
  checkedAt = "2026-10-31T12:00:00.000Z",
): CompletePartition {
  const coverageStartUtc = DateTime.fromISO(localDate, { zone: TIME_ZONE })
    .startOf("day")
    .toUTC()
    .toISO()!;
  const coverageEndUtc = DateTime.fromISO(localDate, { zone: TIME_ZONE })
    .plus({ days: 1 })
    .startOf("day")
    .toUTC()
    .toISO()!;
  return {
    state: "complete",
    localDate,
    checkedAt,
    coverageStartUtc,
    coverageEndUtc,
    openings,
    note: "Reserve start markers; duration unknown.",
  };
}

function failed(
  localDate: string,
  checkedAt = "2026-10-31T12:01:00.000Z",
): PartitionResult {
  return {
    state: "failed",
    localDate,
    checkedAt,
    errorCode: "unavailable",
    message: "Provider read failed.",
  };
}

function run(overrides: Partial<RefreshRun> = {}): RefreshRun {
  return {
    id: "run-1",
    startedAt: "2026-10-31T12:00:00.000Z",
    finishedAt: null,
    outcome: "running",
    requestedDates: 8,
    completedDates: 0,
    requests: 0,
    elapsedMs: 0,
    errorCode: null,
    message: null,
    diagnostic: null,
    ...overrides,
  };
}

describe("SQLite schedule store", () => {
  let root: string;
  let store: ScheduleStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tennis-schedule-store-"));
    store = new ScheduleStore(join(root, "schedule.sqlite"));
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("atomically replaces a complete partition including vanished markers", () => {
    const first = opening(DAY, "01:30");
    store.publish(complete(DAY, [first]));
    store.publish(complete(DAY, [], "2026-10-31T12:02:00.000Z"));

    const view = store.readPartitions(
      [DAY],
      Date.parse("2026-11-01T08:00:00Z"),
      60,
    )[0]!;
    assert.equal(view.coverage, "complete");
    assert.deepEqual(view.openings, []);
    assert.equal(view.lastSuccessAt, "2026-10-31T12:02:00.000Z");
  });

  it("preserves complete observations and success timestamps after a failure", () => {
    const marker = opening(DAY, "01:30");
    store.publish(complete(DAY, [marker]));
    store.publish(failed(DAY));

    const view = store.readPartitions(
      [DAY],
      Date.parse("2026-10-31T12:00:00Z"),
      60,
    )[0]!;
    assert.equal(view.coverage, "complete");
    assert.deepEqual(view.openings, [marker]);
    assert.equal(view.lastSuccessAt, "2026-10-31T12:00:00.000Z");
    assert.equal(view.lastAttemptAt, "2026-10-31T12:01:00.000Z");
    assert.equal(view.errorCode, "unavailable");
    assert.equal(view.isStale, true);
  });

  it("rejects cross-date or malformed complete data without replacing the cached partition", () => {
    const marker = opening(DAY, "01:30");
    store.publish(complete(DAY, [marker]));
    const corrupt = complete("2026-11-02", [marker]);
    assert.throws(() => store.publish(corrupt), /Invalid partition result/);
    assert.deepEqual(
      store.readPartitions([DAY], Date.parse("2026-10-31T12:00:00Z"), 60)[0]!
        .openings,
      [marker],
    );
  });

  it("isolates partition status by date and filters past starts without changing coverage", () => {
    const today = complete(DAY, [opening(DAY, "01:30")]);
    const tomorrow = complete("2026-11-02", [
      opening("2026-11-02", "09:00", 12),
    ]);
    store.publish(today);
    store.publish(tomorrow);
    store.publish(failed(DAY));

    const views = store.readPartitions(
      [DAY, "2026-11-02"],
      Date.parse("2026-11-01T07:00:00Z"),
      120,
    );
    assert.equal(views[0]!.openings.length, 0);
    assert.equal(views[0]!.coverage, "complete");
    assert.equal(views[0]!.errorCode, "unavailable");
    assert.equal(views[1]!.openings.length, 1);
    assert.equal(views[1]!.errorCode, null);
  });

  it("persists strict preferences and revision through restart", () => {
    const previousRevision = store.revision();
    const updated = store.updatePreferences({
      view: "day",
      durationMinutes: 60,
      courtIds: [11, 12],
    });
    const revision = store.revision();
    assert.notEqual(revision, previousRevision);
    store.updatePreferences(updated);
    assert.equal(store.revision(), revision);
    assert.throws(
      () => store.updatePreferences({ unknown: true } as never),
      /Invalid preferences/,
    );
    store.close();
    store = new ScheduleStore(join(root, "schedule.sqlite"));
    assert.deepEqual(store.readPreferences(), updated);
    assert.equal(store.revision(), revision);
    assert.deepEqual(store.readPreferences().includeUnknownDuration, true);
  });

  it("uses New York calendar arithmetic across the daylight-saving transition", () => {
    assert.deepEqual(dateRange("2026-10-31", 8), [
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
    ]);
    const firstFold = opening(DAY, "01:30");
    firstFold.startUtc = "2026-11-01T05:30:00.000Z";
    firstFold.id = `11:${firstFold.startUtc}`;
    const secondFold = opening(DAY, "01:30", 12);
    secondFold.startUtc = "2026-11-01T06:30:00.000Z";
    secondFold.id = `12:${secondFold.startUtc}`;
    const repeatedHour = complete(DAY, [firstFold, secondFold]);
    assert.equal(
      Date.parse(secondFold.startUtc) - Date.parse(firstFold.startUtc),
      60 * 60 * 1000,
    );
    assert.notEqual(
      repeatedHour.openings[0]!.startUtc,
      repeatedHour.openings[1]!.startUtc,
    );
    store.publish(repeatedHour);
    assert.equal(
      store.readPartitions([DAY], Date.parse("2026-10-31T12:00:00Z"), 120)[0]!
        .openings.length,
      2,
    );
  });

  it("rejects duplicate court-time markers and prunes past snapshots and old checks", () => {
    const marker = opening(DAY, "09:00");
    const duplicate = { ...marker, id: "different-native-id" };
    assert.throws(
      () => store.publish(complete(DAY, [marker, duplicate])),
      /Invalid partition result/,
    );

    store.publish(complete(DAY, [marker]));
    store.publish(complete("2026-11-02", []));
    store.publish(failed("2026-11-02"));
    store.prune("2026-11-02", "2026-11-01T00:00:00.000Z");
    assert.equal(
      store.readPartitions([DAY, "2026-11-02"], Date.now(), 120)[0]!.coverage,
      "unknown",
    );
    assert.equal(
      store.readPartitions(["2026-11-02"], Date.now(), 120)[0]!.coverage,
      "complete",
    );
    const remaining = store.readPartitions(
      ["2026-11-02"],
      Date.parse("2026-10-31T12:00:00Z"),
      120,
    )[0]!;
    assert.equal(remaining.errorCode, null);
    assert.equal(remaining.lastAttemptAt, "2026-10-31T12:00:00.000Z");
  });

  it("persists a run lifecycle across restart and returns newest runs within bounds", () => {
    store.recordRun(run());
    const startedRevision = store.revision();
    store.recordRun(run());
    assert.equal(store.revision(), startedRevision);
    store.recordRun(
      run({
        finishedAt: "2026-10-31T12:01:00.000Z",
        outcome: "healthy",
        completedDates: 8,
        requests: 10,
        elapsedMs: 60_000,
      }),
    );
    store.recordRun(
      run({
        id: "run-2",
        startedAt: "2026-10-31T12:02:00.000Z",
        finishedAt: "2026-10-31T12:03:00.000Z",
        outcome: "failed",
        errorCode: "unavailable",
        message: "See https://example.invalid and token=private-value",
      }),
    );
    const beforeTerminalReplay = store.revision();
    store.recordRun(run());
    assert.equal(store.revision(), beforeTerminalReplay);
    assert.deepEqual(
      store.readRuns(1).map(({ id }) => id),
      ["run-2"],
    );
    assert.equal(
      store.readRuns(2)[0]!.message,
      "See [redacted] and [redacted]",
    );
    assert.throws(() => store.readRuns(0), /Invalid diagnostics limit/);
    assert.throws(() => store.readChecks(101), /Invalid diagnostics limit/);

    store.close();
    store = new ScheduleStore(join(root, "schedule.sqlite"));
    assert.deepEqual(
      store.readRuns().map(({ id, outcome }) => [id, outcome]),
      [
        ["run-2", "failed"],
        ["run-1", "healthy"],
      ],
    );
  });

  it("strictly validates run semantics and diagnostic fields before saving", () => {
    assert.throws(
      () => store.recordRun({ ...run(), extra: "no" } as never),
      /Invalid refresh run/,
    );
    assert.throws(
      () =>
        store.recordRun(
          run({
            diagnostic: {
              stage: "collection",
              kind: "network-error",
              endpoint: "schedule-data",
              headers: { authorization: "secret" },
            } as never,
          }),
        ),
      /Invalid refresh run/,
    );
    assert.throws(
      () => store.recordRun(run({ completedDates: 9 })),
      /Invalid refresh run/,
    );
    assert.throws(
      () =>
        store.recordRun(
          run({
            outcome: "healthy",
            finishedAt: "2026-10-31T11:59:59.000Z",
          }),
        ),
      /Invalid refresh run/,
    );
    assert.throws(
      () => store.recordRun(run({ finishedAt: "2026-10-31T12:01:00.000Z" })),
      /Invalid refresh run/,
    );
    assert.deepEqual(store.readRuns(), []);
  });

  it("interrupts only runs already started and reports safe cancellation metadata", () => {
    store.recordRun(run());
    store.recordRun(
      run({ id: "future-run", startedAt: "2026-10-31T12:02:00.000Z" }),
    );
    const revision = store.revision();
    assert.equal(store.interruptRuns("2026-10-31T12:01:00.000Z"), 1);
    assert.notEqual(store.revision(), revision);
    const interrupted = store.readRuns(2).find(({ id }) => id === "run-1")!;
    assert.equal(interrupted.outcome, "interrupted");
    assert.equal(interrupted.errorCode, "unavailable");
    assert.equal(interrupted.message, "Refresh interrupted during shutdown.");
    assert.deepEqual(interrupted.diagnostic, {
      stage: "collection",
      kind: "cancelled",
      endpoint: null,
    });
    assert.equal(interrupted.elapsedMs, 60_000);
    const afterInterrupt = store.revision();
    assert.equal(store.interruptRuns("2026-10-31T12:01:00.000Z"), 0);
    assert.equal(store.revision(), afterInterrupt);
  });

  it("reads only bounded partition-check metadata and prunes run history at the cutoff", () => {
    store.publish(complete(DAY, [opening(DAY, "09:00")]));
    store.publish(failed(DAY));
    store.recordRun(
      run({
        id: "old-run",
        startedAt: "2026-10-20T12:00:00.000Z",
      }),
    );
    store.recordRun(
      run({
        id: "recent-run",
        startedAt: "2026-10-30T12:00:00.000Z",
      }),
    );
    const beforePrune = store.revision();
    assert.deepEqual(store.readChecks(1), [
      {
        localDate: DAY,
        checkedAt: "2026-10-31T12:01:00.000Z",
        state: "failed",
        errorCode: "unavailable",
        message: "Provider read failed.",
      },
    ]);
    store.prune(DAY, "2026-10-23T12:00:00.000Z");
    assert.notEqual(store.revision(), beforePrune);
    assert.deepEqual(
      store.readRuns().map(({ id }) => id),
      ["recent-run"],
    );

    const afterPrune = store.revision();
    store.prune(DAY, "2026-10-23T12:00:00.001Z");
    assert.deepEqual(
      store.readRuns().map(({ id }) => id),
      ["recent-run"],
    );
    assert.equal(store.revision(), afterPrune);
  });

  it("migrates a v2 database without rewriting its cache, preferences, status, or pause metadata", () => {
    store.close();
    const path = join(root, "legacy-v2.sqlite");
    const legacy = new DatabaseSync(path);
    const cached = opening(DAY, "09:00");
    const snapshot = complete(DAY, [cached]);
    const status = {
      id: "mccarren",
      name: "McCarren Tennis Center",
      timeZone: TIME_ZONE,
      bookingUrl: BOOKING_URL,
      transport: "browser-dom",
      health: "needs-login",
      message: "Reconnect required.",
      sessionPresent: true,
      isRefreshing: false,
      collectionPaused: false,
      cadenceSeconds: 120,
      lastAttemptAt: "2026-10-31T12:01:00.000Z",
      lastSuccessAt: snapshot.checkedAt,
      nextDueAt: null,
    };
    legacy.exec(`
      CREATE TABLE partitions (
        local_date TEXT PRIMARY KEY, coverage_start_utc TEXT NOT NULL,
        coverage_end_utc TEXT NOT NULL, openings_json TEXT NOT NULL,
        last_success_at TEXT NOT NULL
      );
      CREATE TABLE partition_checks (
        id INTEGER PRIMARY KEY, local_date TEXT NOT NULL, checked_at TEXT NOT NULL,
        checked_at_ms INTEGER NOT NULL, state TEXT NOT NULL,
        error_code TEXT, message TEXT
      );
      CREATE INDEX partition_checks_date_id ON partition_checks(local_date, id DESC);
      CREATE INDEX partition_checks_checked_at ON partition_checks(checked_at_ms);
      CREATE TABLE preferences (id INTEGER PRIMARY KEY CHECK (id = 1), value_json TEXT NOT NULL);
      CREATE TABLE source_status (id INTEGER PRIMARY KEY CHECK (id = 1), value_json TEXT NOT NULL);
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 2;
    `);
    legacy
      .prepare("INSERT INTO partitions VALUES (?, ?, ?, ?, ?)")
      .run(
        snapshot.localDate,
        snapshot.coverageStartUtc,
        snapshot.coverageEndUtc,
        JSON.stringify(snapshot.openings),
        snapshot.checkedAt,
      );
    legacy
      .prepare(
        "INSERT INTO partition_checks VALUES (1, ?, ?, ?, 'complete', NULL, NULL)",
      )
      .run(
        snapshot.localDate,
        snapshot.checkedAt,
        Date.parse(snapshot.checkedAt),
      );
    legacy.prepare("INSERT INTO preferences VALUES (1, ?)").run(
      JSON.stringify({
        view: "day",
        durationMinutes: 60,
        includeUnknownDuration: false,
        courtIds: [11],
      }),
    );
    legacy
      .prepare("INSERT INTO source_status VALUES (1, ?)")
      .run(JSON.stringify(status));
    legacy.prepare("INSERT INTO metadata VALUES ('revision', '41')").run();
    legacy
      .prepare("INSERT INTO metadata VALUES ('paused-session-revision', ?)")
      .run(JSON.stringify("session-rev-1"));
    legacy.close();

    store = new ScheduleStore(path);
    assert.deepEqual(
      store.readPartitions([DAY], Date.parse("2026-10-31T12:00:00Z"), 120)[0]!
        .openings,
      [cached],
    );
    assert.deepEqual(store.readPreferences(), {
      view: "day",
      durationMinutes: 60,
      includeUnknownDuration: false,
      courtIds: [11],
    });
    assert.deepEqual(store.getStatus(), status);
    assert.equal(store.readPausedSessionRevision(), "session-rev-1");
    assert.equal(store.revision(), "41");
    assert.deepEqual(store.readRuns(), []);
  });
});
