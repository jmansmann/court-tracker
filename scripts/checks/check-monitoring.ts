import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  DiagnosticsResponseSchema,
  RefreshResponseSchema,
} from "../../packages/contracts/src/index.ts";

// Incident-specific local check: it assumes the paused/rate-limited state and
// verifies deferred refresh without contacting CourtReserve.
const base = "http://127.0.0.1:4317";
const before = DiagnosticsResponseSchema.parse(
  await (await fetch(`${base}/api/diagnostics`)).json(),
);
assert.equal(before.source.health, "rate-limited");
assert.equal(before.source.collectionPaused, true);
assert.equal(before.collection.status, "paused");
assert.ok(
  before.source.nextDueAt && Date.parse(before.source.nextDueAt) > Date.now(),
);
assert.equal(before.source.providerNotBefore, before.source.nextDueAt);
assert.equal((await fetch(`${base}/health/ready`)).status, 200);
assert.equal((await fetch(`${base}/health/collection`)).status, 503);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors: string[] = [];
  page.on("pageerror", () => {
    errors.push("page-error");
  });
  page.on("request", (request) => {
    if (
      /^https?:/.test(request.url()) &&
      new URL(request.url()).origin !== base
    )
      errors.push("unexpected-external-request");
  });
  await page.goto(base);
  await page
    .getByText("Refresh activity & diagnostics", { exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Collection status", exact: true })
    .waitFor();
  await page
    .getByText(/schedule stage · http error · schedule data · HTTP 429/)
    .first()
    .waitFor();
  await page
    .getByText("Recorded provider not-before", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page.locator(".diagnostics-service-note").innerText(),
    "The local app service is responding; this is separate from McCarren collection freshness.",
  );
  const pausedRefresh = page.getByRole("button", {
    name: "Collection paused locally",
  });
  assert.equal(await pausedRefresh.isDisabled(), true);
  const refreshResponse = await page.evaluate(async () => {
    const response = await fetch("/api/refresh-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(refreshResponse.status, 202);
  const refresh = RefreshResponseSchema.parse(refreshResponse.body);
  assert.equal(refresh.status, "deferred");
  assert.equal(refresh.providerNotBefore, before.source.providerNotBefore);
  if (process.env.APP_SCREENSHOT_PATH)
    await page.screenshot({
      path: process.env.APP_SCREENSHOT_PATH,
      fullPage: true,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  const after = DiagnosticsResponseSchema.parse(
    await (await fetch(`${base}/api/diagnostics`)).json(),
  );
  assert.equal(after.source.lastAttemptAt, before.source.lastAttemptAt);
  assert.equal(after.source.lastSuccessAt, before.source.lastSuccessAt);
  assert.equal(after.source.nextDueAt, before.source.nextDueAt);
  assert.equal(after.runs.length, before.runs.length);
  console.log(
    JSON.stringify({
      state: "paused-monitoring-verified",
      readiness: 200,
      collectionHealth: 503,
      lastDiagnosticStatus: after.source.lastDiagnostic?.httpStatus,
      providerNotBefore: after.source.nextDueAt,
      manualRefresh: "deferred",
      providerRequestsTriggered: 0,
    }),
  );
} finally {
  await browser.close();
}
