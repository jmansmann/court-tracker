import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOKING_URL,
  ScheduleResponseSchema,
  type CompletePartition,
  type ScheduleConnector,
} from "../../../packages/contracts/src/index.ts";
import { buildApp } from "./http.ts";
import { ScheduleStore } from "./store.ts";
import { RefreshScheduler } from "./scheduler.ts";

test("local HTTP API validates inputs and origins while keeping provider errors independent of cached schedules", async () => {
  const now = Date.parse("2026-10-31T05:00:00Z");
  const store = new ScheduleStore(":memory:");
  let collections = 0;
  const connector: ScheduleConnector = {
    collect: async () => {
      collections++;
      return {
        attemptedDates: 0,
        completedDates: 0,
        elapsedMs: 0,
        requests: 0,
      };
    },
    close: async () => {},
  };
  const scheduler = new RefreshScheduler({
    store,
    connector,
    sessionRevision: async () => null,
    now: () => now,
  });
  const app = await buildApp({ store, scheduler, port: 4317, now: () => now });
  const headers = { host: "127.0.0.1:4317" };
  const partition: CompletePartition = {
    state: "complete",
    localDate: "2026-10-31",
    checkedAt: new Date(now).toISOString(),
    coverageStartUtc: "2026-10-31T10:00:00Z",
    coverageEndUtc: "2026-11-01T03:59:00Z",
    note: null,
    openings: [
      {
        id: "34737:2026-10-31T11:00:00Z",
        sourceId: "mccarren",
        courtId: 34737,
        courtLabel: "Court #1 (Singles Court)",
        localDate: "2026-10-31",
        localTime: "07:00",
        startUtc: "2026-10-31T11:00:00Z",
        endUtc: null,
        kind: "reserve-start",
        providerLabel: "Reserve",
        durationMinutes: null,
        price: null,
        eligibility: "unknown",
        bookingUrl: BOOKING_URL,
        observedAt: new Date(now).toISOString(),
      },
    ],
  };
  try {
    store.publish(partition);
    store.publish({
      state: "failed",
      localDate: "2026-10-31",
      checkedAt: new Date(now + 1000).toISOString(),
      errorCode: "needs-login",
      message: "Reconnect with make connect.",
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/schedule?from=2026-10-31&days=7",
      headers,
    });
    assert.equal(response.statusCode, 200);
    const data = ScheduleResponseSchema.parse(response.json());
    assert.equal(data.partitions.length, 7);
    assert.equal(data.partitions[0]!.openings.length, 1);
    assert.equal(data.partitions[0]!.errorCode, "needs-login");
    assert.equal(data.partitions[0]!.isStale, true);
    assert.equal(data.partitions[0]!.lastSuccessAt, partition.checkedAt);
    assert.equal(data.partitions[1]!.coverage, "unknown");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.match(
      String(response.headers["content-security-policy"]),
      /frame-ancestors 'none'/,
    );
    assert.equal(collections, 0, "cached GETs never collect provider data");
    for (const query of [
      "days=8",
      "days=0",
      "from=2026-02-30",
      "from=secret&password=bad",
      "days=7&extra=1",
    ]) {
      const result = await app.inject({
        url: `/api/schedule?${query}`,
        headers,
      });
      assert.equal(result.statusCode, 422);
      assert.equal(result.json().error.code, "VALIDATION_ERROR");
      assert.equal(result.body.includes("secret"), false);
    }
    for (const hostileHeaders of [
      { host: "attacker.example:4317" },
      { ...headers, origin: "https://attacker.example" },
      { ...headers, "sec-fetch-site": "cross-site" },
    ]) {
      assert.equal(
        (await app.inject({ url: "/api/schedule", headers: hostileHeaders }))
          .statusCode,
        403,
      );
    }
    const preferences = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers,
      payload: {
        view: "day",
        durationMinutes: 60,
        includeUnknownDuration: false,
      },
    });
    assert.equal(preferences.statusCode, 200);
    assert.equal(preferences.json().includeUnknownDuration, false);
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/preferences",
          headers,
          payload: { token: "must-not-store" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/refresh-requests",
          headers: { ...headers, "content-type": "text/plain" },
          payload: "{}",
        })
      ).statusCode,
      415,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/refresh-requests",
          headers,
          payload: { force: true },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/refresh-requests",
          headers,
          payload: {},
        })
      ).statusCode,
      202,
    );
    assert.equal(
      (await app.inject({ url: "/health/ready", headers })).statusCode,
      200,
    );
    const diagnostics = await app.inject({
      url: "/api/diagnostics?limit=10",
      headers,
    });
    assert.equal(diagnostics.statusCode, 200);
    assert.equal(diagnostics.json().checks.length, 2);
    assert.equal(
      diagnostics.json().runs.length,
      0,
      "legacy date checks remain available before run-level logging exists",
    );
    assert.equal(
      (await app.inject({ url: "/health/collection", headers })).statusCode,
      503,
      "service readiness is distinct from collection health",
    );
    assert.equal(
      (await app.inject({ url: "/api/diagnostics?limit=101", headers }))
        .statusCode,
      422,
    );
    store.setPausedSessionRevision("private-metadata-must-not-be-exposed");
    assert.equal(
      (await app.inject({ url: "/api/diagnostics", headers })).body.includes(
        "private-metadata-must-not-be-exposed",
      ),
      false,
    );
    assert.equal(
      (await app.inject({ url: "/.local/mccarren/session.json", headers }))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test("built assets are allowlisted without wildcard source or symlink access", async () => {
  const root = await mkdtemp(join(tmpdir(), "mccarren-http-"));
  const store = new ScheduleStore(":memory:");
  const scheduler = new RefreshScheduler({
    store,
    sessionRevision: async () => null,
    connector: {
      collect: async () => ({
        attemptedDates: 0,
        completedDates: 0,
        elapsedMs: 0,
        requests: 0,
      }),
      close: async () => {},
    },
  });
  try {
    await mkdir(join(root, "assets"));
    await writeFile(
      join(root, "index.html"),
      "<!doctype html><title>Controlled built app</title>",
    );
    await writeFile(
      join(root, "assets", "index-test.js"),
      "console.log('controlled asset');",
    );
    const architectureHtml =
      "<!doctype html><title>Local architecture</title><script>window.diagramReady = true;</script>";
    await writeFile(join(root, "architecture.html"), architectureHtml);
    await writeFile(join(root, "private.json"), "private-fixture");
    await symlink(
      join(root, "private.json"),
      join(root, "assets", "private.js"),
    );
    const app = await buildApp({
      store,
      scheduler,
      port: 4317,
      webRoot: root,
      architectureHtml: join(root, "architecture.html"),
    });
    try {
      const headers = { host: "127.0.0.1:4317" };
      assert.equal((await app.inject({ url: "/", headers })).statusCode, 200);
      const architecture = await app.inject({ url: "/architecture", headers });
      assert.equal(architecture.statusCode, 200);
      assert.equal(architecture.body, architectureHtml);
      assert.match(
        String(architecture.headers["content-security-policy"]),
        /script-src 'unsafe-inline'/,
      );
      assert.match(
        String(architecture.headers["content-security-policy"]),
        /connect-src 'none'/,
      );
      assert.match(
        String(
          (await app.inject({ url: "/assets/index-test.js", headers })).headers[
            "content-type"
          ],
        ),
        /text\/javascript/,
      );
      for (const url of [
        "/private.json",
        "/architecture.html",
        "/assets/private.js",
        "/src/App.tsx",
        "/assets/%2e%2e/private.json",
      ]) {
        const response = await app.inject({ url, headers });
        assert.equal(response.statusCode, 404);
        assert.equal(response.body.includes("private-fixture"), false);
      }
    } finally {
      await app.close();
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
