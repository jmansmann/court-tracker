import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DateTime } from "luxon";
import {
  BOOKING_URL,
  TIME_ZONE,
  dateRange,
  localToday,
  type CollectionOptions,
  type CollectionSummary,
  type PartitionResult,
  type ScheduleConnector,
  type FailedPartition,
} from "../../../packages/contracts/src/index.ts";
import { RefreshScheduler } from "./scheduler.ts";
import { ScheduleStore } from "./store.ts";
import { diagnostics } from "./diagnostics.ts";

function complete(localDate: string, checkedAt: string): PartitionResult {
  return {
    state: "complete",
    localDate,
    checkedAt,
    coverageStartUtc: DateTime.fromISO(localDate, { zone: TIME_ZONE })
      .startOf("day")
      .toUTC()
      .toISO()!,
    coverageEndUtc: DateTime.fromISO(localDate, { zone: TIME_ZONE })
      .plus({ days: 1 })
      .startOf("day")
      .toUTC()
      .toISO()!,
    openings: [],
    note: null,
  };
}

function failed(
  localDate: string,
  checkedAt: string,
  errorCode:
    | "needs-login"
    | "provider-blocked"
    | "rate-limited"
    | "unavailable",
  retryAfterSeconds?: number,
): FailedPartition {
  return {
    state: "failed",
    localDate,
    checkedAt,
    errorCode,
    message: "A generic test refresh failure.",
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

function resultSummary(
  completedDates: number,
  terminalError?: CollectionSummary["terminalError"],
  retryAfterSeconds?: number,
): CollectionSummary {
  return {
    attemptedDates: 8,
    completedDates,
    elapsedMs: 2,
    requests: 1,
    ...(terminalError ? { terminalError } : {}),
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

describe("refresh scheduler", () => {
  let root: string;
  let store: ScheduleStore;
  let now: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tennis-scheduler-"));
    store = new ScheduleStore(join(root, "schedule.sqlite"));
    now = Date.parse("2026-10-31T12:00:00.000Z");
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  function scheduler(
    connector: ScheduleConnector,
    sessionRevision: () => Promise<string | null> = async () => "session-1",
  ): RefreshScheduler {
    return new RefreshScheduler({
      store,
      connector,
      sessionRevision,
      cadenceSeconds: 60,
      now: () => now,
    });
  }

  it("automatically refreshes eight New York dates and manual requests coalesce", async () => {
    let release!: () => Promise<void>;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => (resolveEntered = resolve));
    let calls = 0;
    const connector: ScheduleConnector = {
      async collect(options: CollectionOptions) {
        calls++;
        assert.equal(options.from, "2026-10-31");
        assert.equal(options.days, 8);
        resolveEntered();
        return new Promise<CollectionSummary>((resolve) => {
          release = async () => {
            for (const localDate of dateRange(options.from, options.days)) {
              await options.onPartition(
                complete(localDate, new Date(now).toISOString()),
              );
            }
            resolve(resultSummary(8));
          };
        });
      },
      async close() {},
    };
    const task = scheduler(connector);
    task.start();
    await entered;
    assert.equal(task.requestRefresh().status, "coalesced");
    assert.equal(calls, 1);

    const active = task.waitForIdle();
    await release();
    await active;
    assert.equal(task.status().health, "healthy");
    assert.equal(
      store.readPartitions(dateRange(localToday(now), 8), now, 60).length,
      8,
    );
    await task.stop();
  });

  it("backs off rate limits, honors Retry-After, and defers manual refresh", async () => {
    let calls = 0;
    const connector: ScheduleConnector = {
      async collect(options) {
        calls++;
        const dates = dateRange(options.from, options.days);
        for (const localDate of dates) {
          await options.onPartition(
            failed(localDate, new Date(now).toISOString(), "rate-limited", 300),
          );
        }
        return resultSummary(0, "rate-limited", 300);
      },
      async close() {},
    };
    const task = scheduler(connector);
    task.start();
    await task.waitForIdle();
    assert.equal(calls, 1);
    assert.equal(task.status().health, "rate-limited");
    assert.equal(Date.parse(task.status().nextDueAt!), now + 300_000);
    assert.deepEqual(task.requestRefresh(), {
      status: "deferred",
      nextDueAt: task.status().nextDueAt,
    });

    now += 300_000;
    await task.runDue();
    assert.equal(calls, 2);
    await task.stop();
  });

  it("exponentially backs off transient errors without exceeding its bound", async () => {
    let calls = 0;
    const connector: ScheduleConnector = {
      async collect(options) {
        calls++;
        for (const localDate of dateRange(options.from, options.days)) {
          await options.onPartition(
            failed(localDate, new Date(now).toISOString(), "unavailable"),
          );
        }
        return resultSummary(0, "unavailable");
      },
      async close() {},
    };
    const task = scheduler(connector);
    task.start();
    await task.waitForIdle();
    assert.equal(Date.parse(task.status().nextDueAt!), now + 60_000);
    assert.equal(task.requestRefresh().status, "deferred");

    now += 60_000;
    await task.runDue();
    assert.equal(calls, 2);
    assert.equal(Date.parse(task.status().nextDueAt!), now + 120_000);
    await task.stop();
  });

  it("records redacted run diagnostics and detects reconnects without bypassing a rate-limit cooldown", async () => {
    let revision: string | null = "before-reconnect";
    let calls = 0;
    const events: Record<string, unknown>[] = [];
    const connector: ScheduleConnector = {
      async collect(options) {
        calls++;
        for (const date of dateRange(options.from, options.days))
          await options.onPartition({
            ...failed(date, new Date(now).toISOString(), "rate-limited", 3600),
            diagnostic: {
              stage: "schedule",
              kind: "http-error",
              endpoint: "schedule-data",
              httpStatus: 429,
              networkCode: "net::ERR_FAILED",
            },
          });
        return {
          ...resultSummary(0, "rate-limited", 3600),
          requests: 4,
          diagnostic: {
            stage: "schedule",
            kind: "http-error",
            endpoint: "schedule-data",
            httpStatus: 429,
            networkCode: "net::ERR_FAILED",
          },
        };
      },
      async close() {},
    };
    const task = new RefreshScheduler({
      store,
      connector,
      cadenceSeconds: 900,
      sessionRevision: async () => revision,
      now: () => now,
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      task.start();
      await task.waitForIdle();
      assert.equal(store.readRuns()[0]!.diagnostic?.httpStatus, 429);
      assert.equal(store.readRuns()[0]!.requests, 4);
      assert.equal(store.readRuns()[0]!.outcome, "failed");
      const originalDue = task.status().nextDueAt;
      revision = null;
      now += 60000;
      await task.runDue();
      assert.equal(calls, 1);
      assert.equal(
        task.status().health,
        "rate-limited",
        "temporarily missing session files cannot erase the provider cooldown",
      );
      assert.equal(task.status().nextDueAt, originalDue);
      revision = "after-reconnect";
      now += 60000;
      await task.runDue();
      assert.equal(calls, 1);
      assert.equal(task.status().nextDueAt, originalDue);
      assert.equal(task.requestRefresh().status, "deferred");
      assert.equal(
        events.some((event) => event.event === "session.changed"),
        true,
      );
      assert.equal(
        events.some((event) => event.event === "refresh.started"),
        true,
      );
      assert.equal(
        events.some(
          (event) =>
            event.event === "refresh.finished" &&
            event.errorCode === "rate-limited",
        ),
        true,
      );
      assert.equal(
        JSON.stringify(events).includes("after-reconnect"),
        false,
        "session metadata is not logged",
      );
      await task.stop();
      store.close();
      store = new ScheduleStore(join(root, "schedule.sqlite"));
      const restarted = new RefreshScheduler({
        store,
        connector,
        cadenceSeconds: 900,
        sessionRevision: async () => "another-reconnect",
        now: () => now,
      });
      try {
        restarted.start();
        await restarted.waitForIdle();
        assert.equal(
          calls,
          1,
          "restart plus reconnect must still honor persisted Retry-After",
        );
        assert.equal(restarted.status().nextDueAt, originalDue);
      } finally {
        await restarted.stop();
      }
    } finally {
      await task.stop();
    }
  });

  it("bounds a hung refresh, preserves cache, ignores late results, and pauses unsafe retries", async () => {
    const day = localToday(now);
    const cached = complete(day, new Date(now - 1000).toISOString());
    store.publish(cached);
    let late: CollectionOptions["onPartition"] | undefined;
    let closes = 0;
    let calls = 0;
    const connector: ScheduleConnector = {
      collect: async (options) => {
        calls++;
        late = options.onPartition;
        return new Promise(() => {});
      },
      close: async () => {
        closes++;
      },
    };
    const task = new RefreshScheduler({
      store,
      connector,
      cadenceSeconds: 60,
      sessionRevision: async () => "session",
      now: () => now,
      collectionTimeoutMs: 20,
    });
    try {
      task.start();
      await task.waitForIdle();
      assert.ok(closes > 0);
      assert.equal(task.status().health, "error");
      assert.equal(task.status().nextDueAt, null);
      assert.equal(store.readRuns()[0]!.diagnostic?.kind, "timeout");
      assert.equal(store.readRuns()[0]!.requests, null);
      assert.ok(late);
      await late(complete(day, new Date(now + 1000).toISOString()));
      assert.equal(
        store.readPartitions([day], now, 120)[0]!.lastSuccessAt,
        cached.checkedAt,
      );
      assert.equal(store.readPartitions([day], now, 120)[0]!.isStale, true);
      now += 60000;
      await task.runDue();
      assert.equal(calls, 1);
      assert.equal(task.requestRefresh().status, "deferred");
    } finally {
      await task.stop();
    }
  });

  it("persists a 429 deadline before a collector hangs and preserves it across watchdog and restart", async () => {
    let calls = 0;
    const deadline = now + 7200000;
    const connector: ScheduleConnector = {
      async collect(options) {
        calls++;
        await options.onPartition(
          failed(
            options.from,
            new Date(now).toISOString(),
            "rate-limited",
            7200,
          ),
        );
        return new Promise(() => {});
      },
      async close() {},
    };
    const first = new RefreshScheduler({
      store,
      connector,
      cadenceSeconds: 900,
      sessionRevision: async () => "session",
      now: () => now,
      collectionTimeoutMs: 20,
    });
    first.start();
    try {
      await first.waitForIdle();
      assert.equal(Date.parse(store.readProviderNotBefore()!), deadline);
      assert.equal(Date.parse(first.status().nextDueAt!), deadline);
      assert.equal(first.status().health, "error");
      assert.equal(Date.parse(first.status().providerNotBefore!), deadline);
    } finally {
      await first.stop();
    }
    store.close();
    store = new ScheduleStore(join(root, "schedule.sqlite"));
    const restarted = new RefreshScheduler({
      store,
      connector,
      cadenceSeconds: 900,
      sessionRevision: async () => "reconnected-session",
      now: () => now,
    });
    try {
      restarted.start();
      await restarted.waitForIdle();
      assert.equal(calls, 1);
      assert.equal(restarted.requestRefresh().status, "deferred");
      assert.equal(Date.parse(restarted.status().nextDueAt!), deadline);
      assert.equal(Date.parse(restarted.status().providerNotBefore!), deadline);
    } finally {
      await restarted.stop();
    }
  });

  it("pauses login failures until the session revision changes", async () => {
    let revision: string | null = "revision-a";
    let calls = 0;
    const connector: ScheduleConnector = {
      async collect(options) {
        calls++;
        for (const localDate of dateRange(options.from, options.days)) {
          await options.onPartition(
            failed(localDate, new Date(now).toISOString(), "needs-login"),
          );
        }
        return resultSummary(0, "needs-login");
      },
      async close() {},
    };
    const task = scheduler(connector, async () => revision);
    task.start();
    await task.waitForIdle();
    assert.equal(task.status().health, "needs-login");
    assert.equal(calls, 1);

    now += 60_000;
    await task.runDue();
    assert.equal(calls, 1);
    assert.equal(task.status().health, "needs-login");

    revision = "revision-b";
    now += 60_000;
    await task.runDue();
    assert.equal(calls, 2);
    assert.equal(task.status().health, "needs-login");
    await task.stop();
  });

  it("does not scrape without a session and detects the first session revision", async () => {
    let revision: string | null = null;
    let calls = 0;
    const connector: ScheduleConnector = {
      async collect(options) {
        calls++;
        for (const localDate of dateRange(options.from, options.days)) {
          await options.onPartition(
            complete(localDate, new Date(now).toISOString()),
          );
        }
        return resultSummary(8);
      },
      async close() {},
    };
    const task = scheduler(connector, async () => revision);
    task.start();
    await task.waitForIdle();
    assert.equal(task.status().health, "never-connected");
    assert.equal(calls, 0);
    revision = "first-session";
    now += 60_000;
    await task.runDue();
    assert.equal(calls, 1);
    assert.equal(task.status().health, "healthy");
    await task.stop();
  });

  it("persists login and provider-block pauses through restart until the saved session changes", async () => {
    for (const code of ["needs-login", "provider-blocked"] as const) {
      store.close();
      store = new ScheduleStore(join(root, `${code}.sqlite`));
      let revision = "same-session";
      let calls = 0;
      const connector: ScheduleConnector = {
        async collect(options) {
          calls++;
          const recovered = revision === "new-session";
          for (const date of dateRange(options.from, options.days))
            await options.onPartition(
              recovered
                ? complete(date, new Date(now).toISOString())
                : failed(date, new Date(now).toISOString(), code),
            );
          return resultSummary(recovered ? 8 : 0, recovered ? undefined : code);
        },
        async close() {},
      };
      const first = scheduler(connector, async () => revision);
      first.start();
      await first.waitForIdle();
      await first.stop();
      assert.equal(calls, 1);
      store.close();
      store = new ScheduleStore(join(root, `${code}.sqlite`));
      const restarted = scheduler(connector, async () => revision);
      try {
        now += 60_000;
        await restarted.runDue();
        assert.equal(
          calls,
          1,
          `${code} must not retry the unchanged session after restart`,
        );
        assert.equal(restarted.status().health, code);
        revision = "new-session";
        now += 60_000;
        await restarted.runDue();
        assert.equal(calls, 2);
        assert.equal(restarted.status().health, "healthy");
        assert.equal(store.readPausedSessionRevision(), undefined);
      } finally {
        await restarted.stop();
      }
    }
  });

  it("clears a persisted in-progress status after a process restart", async () => {
    store.setStatus({
      id: "mccarren",
      name: "McCarren Tennis Center",
      timeZone: TIME_ZONE,
      bookingUrl: BOOKING_URL,
      transport: "browser-dom",
      health: "refreshing",
      message: "Refreshing McCarren schedule.",
      sessionPresent: true,
      isRefreshing: true,
      collectionPaused: false,
      cadenceSeconds: 60,
      lastAttemptAt: new Date(now).toISOString(),
      lastSuccessAt: null,
      nextDueAt: null,
    });
    store.close();
    store = new ScheduleStore(join(root, "schedule.sqlite"));
    const task = scheduler({
      async collect() {
        return resultSummary(0);
      },
      async close() {},
    });
    assert.equal(task.status().isRefreshing, false);
    assert.equal(task.status().health, "error");
    assert.match(task.status().message, /interrupted/);
    await task.stop();
  });

  it("keeps cached status while scheduled and manual collection are locally paused", async () => {
    const lastSuccessAt = new Date(now - 60_000).toISOString();
    store.setStatus({
      id: "mccarren",
      name: "McCarren Tennis Center",
      timeZone: TIME_ZONE,
      bookingUrl: BOOKING_URL,
      transport: "browser-dom",
      health: "healthy",
      message: "McCarren schedule is current.",
      sessionPresent: true,
      isRefreshing: false,
      collectionPaused: false,
      cadenceSeconds: 900,
      lastAttemptAt: lastSuccessAt,
      lastSuccessAt,
      nextDueAt: null,
    });
    let calls = 0;
    const task = new RefreshScheduler({
      store,
      connector: {
        async collect() {
          calls++;
          return resultSummary(0);
        },
        async close() {},
      },
      sessionRevision: async () => "session-1",
      cadenceSeconds: 900,
      now: () => now,
      collectionEnabled: false,
    });

    try {
      task.start();
      await task.waitForIdle();
      assert.equal(task.status().collectionPaused, true);
      assert.equal(task.status().lastSuccessAt, lastSuccessAt);
      assert.equal(calls, 0, "startup must not contact the provider");
      assert.equal(
        diagnostics(store, task.status(), now).collection.status,
        "paused",
      );
      assert.deepEqual(task.requestRefresh(), {
        status: "deferred",
        nextDueAt: null,
      });
      await task.runDue();
      assert.equal(calls, 0, "scheduled and manual runs stay paused");
    } finally {
      await task.stop();
    }
  });
});
