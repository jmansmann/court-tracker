import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScheduleStore } from "./store.ts";
import {
  BOOKING_URL,
  TIME_ZONE,
  type SourceStatus,
} from "../../../packages/contracts/src/index.ts";
import {
  providerReadPermission,
  persistObservedRateLimit,
} from "./provider-access.ts";
import { RefreshScheduler } from "./scheduler.ts";

test("provider commands fail closed without local status unless explicitly enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "tennis-budget-default-"));
  const path = join(root, "missing.sqlite");
  const previousSetting = process.env.COLLECTION_ENABLED;
  try {
    delete process.env.COLLECTION_ENABLED;
    const disabledByDefault = providerReadPermission(path);
    assert.equal(disabledByDefault.allowed, false);
    assert.match(disabledByDefault.message, /disabled by default/i);

    process.env.COLLECTION_ENABLED = "true";
    assert.deepEqual(providerReadPermission(path), { allowed: true });

    process.env.COLLECTION_ENABLED = "false";
    assert.equal(providerReadPermission(path).allowed, false);
  } finally {
    if (previousSetting === undefined) delete process.env.COLLECTION_ENABLED;
    else process.env.COLLECTION_ENABLED = previousSetting;
    await rm(root, { recursive: true, force: true });
  }
});

test("provider commands fail closed on pre-pause status until explicitly enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "tennis-budget-legacy-"));
  const path = join(root, "schedule.sqlite");
  const previousSetting = process.env.COLLECTION_ENABLED;
  let store: ScheduleStore | undefined;
  let database: DatabaseSync | undefined;
  try {
    delete process.env.COLLECTION_ENABLED;
    store = new ScheduleStore(path);
    store.setStatus({
      id: "mccarren",
      name: "McCarren Tennis Center",
      timeZone: TIME_ZONE,
      bookingUrl: BOOKING_URL,
      transport: "browser-dom",
      health: "healthy",
      message: "Current",
      sessionPresent: true,
      isRefreshing: false,
      collectionPaused: false,
      cadenceSeconds: 900,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextDueAt: null,
    });
    store.close();
    store = undefined;

    database = new DatabaseSync(path);
    database
      .prepare("UPDATE source_status SET value_json = ? WHERE id = 1")
      .run(
        JSON.stringify({
          id: "mccarren",
          name: "McCarren Tennis Center",
          timeZone: TIME_ZONE,
          bookingUrl: BOOKING_URL,
          transport: "browser-dom",
          health: "healthy",
          message: "Current",
          sessionPresent: true,
          isRefreshing: false,
          cadenceSeconds: 900,
          lastAttemptAt: null,
          lastSuccessAt: null,
          nextDueAt: null,
        }),
      );
    database.close();
    database = undefined;

    assert.equal(providerReadPermission(path).allowed, false);
    process.env.COLLECTION_ENABLED = "true";
    assert.equal(providerReadPermission(path).allowed, true);
  } finally {
    store?.close();
    database?.close();
    if (previousSetting === undefined) delete process.env.COLLECTION_ENABLED;
    else process.env.COLLECTION_ENABLED = previousSetting;
    await rm(root, { recursive: true, force: true });
  }
});

test("operator probes refuse persisted rate-limit cooldowns and active collections without contacting the provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "tennis-budget-"));
  const path = join(root, "schedule.sqlite");
  const now = Date.parse("2026-10-31T13:08:59Z");
  const store = new ScheduleStore(path);
  try {
    const source: SourceStatus = {
      id: "mccarren" as const,
      name: "McCarren Tennis Center" as const,
      timeZone: TIME_ZONE,
      bookingUrl: BOOKING_URL,
      transport: "browser-dom" as const,
      health: "rate-limited" as const,
      message: "Rate limited",
      sessionPresent: true,
      isRefreshing: false,
      collectionPaused: false,
      cadenceSeconds: 900,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextDueAt: "2026-11-01T06:15:38Z",
    };
    store.setStatus(source);
    assert.equal(providerReadPermission(path, now).allowed, false);
    assert.equal(
      providerReadPermission(path, Date.parse(source.nextDueAt!) + 1).allowed,
      true,
    );
    store.setProviderNotBefore(null);
    store.setStatus({
      ...source,
      health: "healthy",
      nextDueAt: null,
      collectionPaused: true,
    });
    const pausedPermission = providerReadPermission(path, now + 90_000_000);
    assert.equal(pausedPermission.allowed, false);
    assert.match(
      pausedPermission.message,
      /paused locally.*No provider request was made/,
    );
    store.setStatus({
      ...source,
      health: "refreshing",
      isRefreshing: true,
      nextDueAt: null,
    });
    assert.equal(providerReadPermission(path, now).allowed, false);
    store.setStatus({ ...source, health: "healthy", nextDueAt: null });
    assert.equal(providerReadPermission(path, now).allowed, true);
    store.setProviderNotBefore(source.nextDueAt!);
    assert.equal(
      providerReadPermission(path, now).allowed,
      false,
      "a session/status change cannot discard the independent provider deadline",
    );
    assert.equal(
      providerReadPermission(path, Date.parse(source.nextDueAt!) + 1).allowed,
      true,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a probe-observed 429 durably blocks the next probe and service startup without changing cached success", async () => {
  const root = await mkdtemp(join(tmpdir(), "tennis-probe-limit-"));
  const path = join(root, "schedule.sqlite");
  const now = Date.parse("2026-10-31T13:08:59Z");
  const success = "2026-10-31T06:13:23Z";
  const store = new ScheduleStore(path);
  try {
    store.setStatus({
      id: "mccarren",
      name: "McCarren Tennis Center",
      timeZone: TIME_ZONE,
      bookingUrl: BOOKING_URL,
      transport: "browser-dom",
      health: "healthy",
      message: "Current",
      sessionPresent: true,
      isRefreshing: false,
      collectionPaused: false,
      cadenceSeconds: 900,
      lastAttemptAt: success,
      lastSuccessAt: success,
      nextDueAt: null,
    });
    const deadline = persistObservedRateLimit(
      { observedAt: new Date(now).toISOString(), retryAfterSeconds: 7200 },
      path,
    );
    assert.equal(deadline, new Date(now + 7200000).toISOString());
    assert.equal(providerReadPermission(path, now).allowed, false);
    assert.equal(store.getStatus()!.lastSuccessAt, success);
    assert.equal(
      store.readChecks().length,
      0,
      "a diagnostic read must not publish schedule coverage",
    );
    assert.equal(
      persistObservedRateLimit(
        {
          observedAt: new Date(now + 1000).toISOString(),
          retryAfterSeconds: 60,
        },
        path,
      ),
      deadline,
      "a later shorter limit cannot shorten the existing deadline",
    );
    let calls = 0;
    const scheduler = new RefreshScheduler({
      store,
      connector: {
        collect: async () => {
          calls++;
          return {
            attemptedDates: 0,
            completedDates: 0,
            requests: 0,
            elapsedMs: 0,
          };
        },
        close: async () => {},
      },
      sessionRevision: async () => "session",
      now: () => now,
    });
    try {
      scheduler.start();
      await scheduler.waitForIdle();
      assert.equal(calls, 0);
      assert.equal(scheduler.status().nextDueAt, deadline);
    } finally {
      await scheduler.stop();
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
