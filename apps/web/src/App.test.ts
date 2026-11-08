import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DateTime } from "luxon";
import { chromium } from "playwright";
import { createServer } from "vite";
import {
  BOOKING_URL,
  PreferencesSchema,
  type RefreshResponse,
  type DiagnosticsResponse,
  type Opening,
  type Preferences,
  type ScheduleResponse,
  type SourceStatus,
} from "../../../packages/contracts/src/index.ts";

const ZONE = "America/New_York";
const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const viteConfig = path.resolve(webRoot, "vite.config.ts");

function sourceStatus(
  needsLogin: boolean,
  collectionPaused = false,
  providerNotBefore: string | null = null,
): SourceStatus {
  const now = DateTime.utc().toISO()!;
  return {
    id: "mccarren",
    name: "McCarren Tennis Center",
    timeZone: ZONE,
    bookingUrl: BOOKING_URL,
    transport: "browser-dom",
    health: needsLogin ? "needs-login" : "healthy",
    message: needsLogin
      ? "McCarren needs a new login."
      : "Schedule is current.",
    sessionPresent: !needsLogin,
    isRefreshing: false,
    collectionPaused,
    cadenceSeconds: 60,
    lastAttemptAt: now,
    lastSuccessAt: now,
    nextDueAt: providerNotBefore
      ? null
      : collectionPaused
        ? DateTime.utc().plus({ minutes: 30 }).toISO()!
        : null,
    providerNotBefore,
  };
}

function opening(
  date: string,
  id: string,
  time: string,
  courtId: number,
  durationMinutes: number | null,
): Opening {
  const start = DateTime.fromISO(`${date}T${time}`, { zone: ZONE });
  return {
    id,
    sourceId: "mccarren",
    courtId,
    courtLabel: `Court ${courtId}`,
    localDate: date,
    localTime: time,
    startUtc: start.toUTC().toISO()!,
    endUtc: null,
    kind: "reserve-start",
    providerLabel: "Reserve",
    durationMinutes,
    price: null,
    eligibility: "unknown",
    bookingUrl: BOOKING_URL,
    observedAt: DateTime.utc().toISO()!,
  };
}

function scheduleFor(
  from: string,
  needsLogin: boolean,
  preferences: Preferences,
  grouped = false,
  collectionPaused = false,
  providerNotBefore: string | null = null,
): ScheduleResponse {
  const now = DateTime.utc().toISO()!;
  const firstDay = DateTime.fromISO(from, { zone: ZONE });
  return {
    revision: `fixture-${from}`,
    range: {
      from,
      to: firstDay.plus({ days: 6 }).toISODate()!,
      timeZone: ZONE,
    },
    source: sourceStatus(needsLogin, collectionPaused, providerNotBefore),
    preferences,
    partitions: Array.from({ length: 7 }, (_, index) => {
      const date = firstDay.plus({ days: index }).toISODate()!;
      const openings =
        index === 0
          ? [
              opening(date, `${date}-known`, "10:00", 1, 60),
              opening(date, `${date}-short`, "10:30", 2, 30),
              opening(date, `${date}-unknown`, "11:00", 3, null),
              ...(grouped
                ? [opening(date, `${date}-another-court`, "10:00", 4, 60)]
                : []),
            ]
          : [];
      if (needsLogin && index === 0)
        return {
          localDate: date,
          coverage: "unknown" as const,
          coverageStartUtc: null,
          coverageEndUtc: null,
          lastAttemptAt: now,
          lastSuccessAt: now,
          isStale: true,
          errorCode: "needs-login" as const,
          message: "Reconnect to refresh this date.",
          openings,
        };
      return {
        localDate: date,
        coverage: "complete" as const,
        coverageStartUtc: firstDay
          .plus({ days: index })
          .startOf("day")
          .toUTC()
          .toISO()!,
        coverageEndUtc: firstDay
          .plus({ days: index + 1 })
          .startOf("day")
          .toUTC()
          .toISO()!,
        lastAttemptAt: now,
        lastSuccessAt: now,
        isStale: false,
        errorCode: null,
        message: null,
        openings,
      };
    }),
  };
}

function diagnosticsFor(
  legacyOnly: boolean,
  collectionPaused = false,
  providerNotBefore: string | null = null,
): DiagnosticsResponse {
  const lastSuccess = DateTime.utc().minus({ hours: 6 }).toISO()!;
  const diagnostic = {
    stage: "schedule" as const,
    kind: "http-error" as const,
    endpoint: "schedule-data" as const,
    httpStatus: 429,
  };
  return {
    source: {
      ...sourceStatus(false, collectionPaused, providerNotBefore),
      health: "error",
      message: "Schedule collection was rate limited (HTTP 429).",
      lastSuccessAt: lastSuccess,
      lastAttemptAt: DateTime.utc().minus({ minutes: 8 }).toISO()!,
      nextDueAt: providerNotBefore
        ? null
        : DateTime.utc().plus({ minutes: 52 }).toISO()!,
      lastDiagnostic: diagnostic,
    },
    collection: {
      status: collectionPaused ? "paused" : "degraded",
      isFresh: false,
      lastSuccessAgeSeconds: 6 * 60 * 60,
      staleAfterSeconds: 240,
    },
    runs: legacyOnly
      ? []
      : [
          {
            id: "run-latest",
            startedAt: DateTime.utc().minus({ minutes: 8 }).toISO()!,
            finishedAt: DateTime.utc().minus({ minutes: 7 }).toISO()!,
            outcome: "failed",
            requestedDates: 8,
            completedDates: 0,
            requests: 4,
            elapsedMs: 11_250,
            errorCode: "rate-limited",
            message:
              "The schedule request returned HTTP 429; retry is deferred.",
            diagnostic,
          },
        ],
    checks: [
      {
        localDate: DateTime.now().setZone(ZONE).toISODate()!,
        checkedAt: DateTime.utc().minus({ minutes: 8 }).toISO()!,
        state: "failed",
        errorCode: "rate-limited",
        message: "Date check retained its previous complete result.",
      },
      {
        localDate: DateTime.now().setZone(ZONE).plus({ days: 1 }).toISODate()!,
        checkedAt: DateTime.utc().minus({ minutes: 9 }).toISO()!,
        state: "complete",
        errorCode: null,
        message: null,
      },
    ],
  };
}

test(
  "McCarren calendar handles views, persisted filters, details, stale/login and fetch errors in Chromium",
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: viteConfig,
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo;
    const browser = await chromium.launch({ headless: true });
    let preferences = PreferencesSchema.parse({});
    let needsLogin = false;
    let scheduleFailure = false;
    let collectionPaused = false;
    let providerNotBefore: string | null = null;
    let grouped = false;
    let holdNextSchedule = false;
    let holdSources = false;
    let diagnosticsMode: "rate-limited" | "legacy" = "rate-limited";
    let diagnosticsFailures = 0;
    let diagnosticsRequests = 0;
    let releasePoll: (() => void) | undefined;
    let releaseSources: (() => void) | undefined;
    let refreshResponse: RefreshResponse = {
      status: "coalesced",
      nextDueAt: null,
    };
    const browserErrors: string[] = [];

    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1050 },
      });
      page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(message.text());
      });
      page.on("pageerror", (error) => browserErrors.push(error.message));
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/schedule") {
          if (holdNextSchedule) {
            holdNextSchedule = false;
            await new Promise<void>((resolve) => {
              releasePoll = resolve;
            });
          }
          if (scheduleFailure) {
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "fixture offline" }),
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
              scheduleFor(
                url.searchParams.get("from")!,
                needsLogin,
                preferences,
                grouped,
                collectionPaused,
                providerNotBefore,
              ),
            ),
          });
          return;
        }
        if (url.pathname === "/api/sources") {
          if (holdSources) {
            await new Promise<void>((resolve) => {
              releaseSources = resolve;
            });
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              sources: [
                sourceStatus(needsLogin, collectionPaused, providerNotBefore),
              ],
            }),
          });
          return;
        }
        if (url.pathname === "/api/diagnostics") {
          diagnosticsRequests++;
          assert.equal(url.searchParams.get("limit"), "12");
          if (diagnosticsFailures > 0) {
            diagnosticsFailures--;
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "fixture offline" }),
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
              diagnosticsFor(
                diagnosticsMode === "legacy",
                collectionPaused,
                providerNotBefore,
              ),
            ),
          });
          return;
        }
        if (
          url.pathname === "/api/preferences" &&
          request.method() === "PATCH"
        ) {
          preferences = PreferencesSchema.parse({
            ...preferences,
            ...request.postDataJSON(),
          });
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(preferences),
          });
          return;
        }
        if (url.pathname === "/api/preferences") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(preferences),
          });
          return;
        }
        if (url.pathname === "/api/refresh-requests") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(refreshResponse),
          });
          return;
        }
        await route.fulfill({ status: 404, body: "not found" });
      });

      await page.goto(`http://127.0.0.1:${address.port}/`);
      await page
        .getByRole("heading", { name: "Find your next court time." })
        .waitFor();
      await page
        .getByRole("button", { name: /10:00 AM, Court 1, 60 minutes/ })
        .waitFor();
      assert.equal(
        diagnosticsRequests,
        0,
        "closed diagnostics are not fetched",
      );
      const diagnostics = page.getByText("Refresh activity & diagnostics", {
        exact: true,
      });
      await diagnostics.click();
      await page
        .getByText(
          "Collection is not fresh (degraded); last full success was about 6 hours ago.",
        )
        .waitFor();
      await page
        .getByText(
          "Source health: error. Schedule collection was rate limited (HTTP 429).",
        )
        .waitFor();
      await page
        .getByText(/schedule stage · http error · schedule data · HTTP 429/)
        .first()
        .waitFor();
      await page.getByText(/4 requests · 0\/8 dates complete/).waitFor();
      assert.equal(diagnosticsRequests, 1);

      await diagnostics.click();
      diagnosticsMode = "legacy";
      await diagnostics.click();
      await page
        .getByText(
          "Earlier history contains date checks only; detailed request diagnostics were not recorded.",
        )
        .waitFor();
      await page
        .getByText(/rate limited/)
        .last()
        .waitFor();

      await diagnostics.click();
      diagnosticsMode = "rate-limited";
      diagnosticsFailures = 1;
      await diagnostics.click();
      await page
        .getByRole("alert")
        .getByText(/Diagnostics could not be loaded/)
        .waitFor();
      await page.getByRole("button", { name: "Retry diagnostics" }).click();
      await page
        .getByRole("heading", { name: "Recent refresh runs" })
        .waitFor();
      assert.equal(diagnosticsRequests, 4);

      assert.equal(
        await page
          .getByRole("table", { name: "Week view of McCarren court starts" })
          .count(),
        1,
      );
      if (process.env.UI_SCREENSHOT_PATH)
        await page.screenshot({
          path: process.env.UI_SCREENSHOT_PATH,
          fullPage: true,
        });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.locator(".mobile-list").isVisible(), true);
      assert.equal(await page.locator(".calendar-grid").isVisible(), false);
      await page.setViewportSize({ width: 1440, height: 1050 });

      await page.getByRole("button", { name: "Next week" }).click();
      const next = DateTime.now().setZone(ZONE).plus({ days: 7 });
      const end = next.plus({ days: 6 });
      await page
        .getByText(
          `${next.toLocaleString({ month: "long", day: "numeric" })} – ${end.toLocaleString({ month: "long", day: "numeric", year: "numeric" })}`,
          { exact: true },
        )
        .waitFor();
      await page.getByRole("button", { name: "Today" }).click();
      await page.getByRole("button", { name: "Day", exact: true }).click();
      await page
        .getByRole("table", { name: "Day view of McCarren court starts" })
        .waitFor();
      await page.getByRole("button", { name: "Next day" }).click();
      await page.getByRole("button", { name: "Today" }).click();
      await page.getByRole("button", { name: "Week", exact: true }).click();
      await page
        .getByRole("table", { name: "Week view of McCarren court starts" })
        .waitFor();

      grouped = true;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page
        .getByRole("button", { name: /10:00 AM, 2 separate court starts/ })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("radio", { name: /Court 4/ })
        .check();
      await page
        .getByRole("dialog")
        .locator("dd")
        .getByText("Court 4", { exact: true })
        .waitFor();
      await page.keyboard.press("Escape");
      grouped = false;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page
        .getByRole("button", { name: /10:00 AM, Court 1, 60 minutes/ })
        .waitFor();

      holdNextSchedule = true;
      const oldPreferenceRead = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/preferences" &&
          response.request().method() === "GET",
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await oldPreferenceRead;
      const savedPreference = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/preferences" &&
          response.request().method() === "PATCH",
      );
      await page.getByLabel("Minimum duration").selectOption("60");
      await savedPreference;
      await page.waitForTimeout(100);
      assert.ok(
        releasePoll,
        "the older poll should still be waiting on its schedule response",
      );
      const released = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/schedule",
      );
      releasePoll();
      await released;
      await page.waitForTimeout(100);
      assert.equal(
        await page.getByLabel("Minimum duration").inputValue(),
        "60",
        "an older poll cannot revert a successfully saved filter",
      );

      await page.getByLabel("Minimum duration").selectOption("60");
      await page
        .getByRole("button", { name: /10:00 AM, Court 1, 60 minutes/ })
        .waitFor();
      await page
        .getByRole("button", { name: /10:30 AM, Court 2, 30 minutes/ })
        .waitFor({ state: "detached" });
      const unknownDuration = page.getByRole("button", {
        name: /11:00 AM, Court 3, duration not published/,
      });
      await unknownDuration.waitFor();
      await page.getByLabel("Include starts with unknown duration").uncheck();
      await unknownDuration.waitFor({ state: "detached" });
      await page.getByLabel("Include starts with unknown duration").check();
      await unknownDuration.waitFor();

      const courtOneFilter = page.getByLabel("Court 1", { exact: true });
      await courtOneFilter.uncheck();
      await page
        .getByRole("button", { name: /10:00 AM, Court 1, 60 minutes/ })
        .waitFor({ state: "detached" });
      await page.getByLabel("Court 2", { exact: true }).uncheck();
      assert.equal(
        await page.getByLabel("Court 3", { exact: true }).isDisabled(),
        true,
      );
      await page
        .getByRole("button", { name: "Show all observed courts" })
        .click();
      await unknownDuration.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Court start" });
      await dialog.waitFor();
      await dialog.getByText("Not published").waitFor();
      await dialog.getByText("Unknown", { exact: true }).waitFor();
      await dialog.getByText("Not verified").waitFor();
      const bookingLink = dialog.getByRole("link", {
        name: "Open McCarren booking site in a new tab",
      });
      assert.equal(await bookingLink.getAttribute("href"), BOOKING_URL);
      assert.equal(await bookingLink.getAttribute("target"), "_blank");
      assert.equal(
        await bookingLink.getAttribute("rel"),
        "noopener noreferrer",
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });

      needsLogin = true;
      await page.reload();
      await page.getByText("needs login", { exact: true }).waitFor();
      await page.getByText("Reconnect command:").waitFor();
      await page
        .locator(".calendar-grid")
        .getByText(/Reconnect McCarren to refresh this date/)
        .waitFor();
      await page
        .getByRole("button", { name: /10:00 AM, Court 1, 60 minutes/ })
        .waitFor();

      scheduleFailure = true;
      await page
        .getByRole("button", { name: "Request a schedule refresh" })
        .click();
      await page
        .getByRole("alert")
        .getByText("Schedule could not be updated")
        .waitFor();
      await page
        .getByRole("button", { name: /10:00 AM, Court 1, 60 minutes/ })
        .waitFor();
      assert.equal(browserErrors.length, 2);
      assert.ok(browserErrors.every((message) => /\b503\b/.test(message)));

      collectionPaused = true;
      needsLogin = false;
      scheduleFailure = false;
      await page.reload();
      await page
        .getByText("Automatic and manual collection are paused locally.", {
          exact: true,
        })
        .waitFor();
      const pausedRefresh = page.getByRole("button", {
        name: "Collection paused locally",
      });
      assert.equal(await pausedRefresh.isDisabled(), true);
      await page
        .locator('.alert[role="status"]')
        .getByText(
          /Collection is paused locally; no automatic or manual provider requests.*Last scheduled due before pause:/,
        )
        .waitFor();
      await diagnostics.click();
      await page
        .getByText(
          "Collection is paused locally; last full success was about 6 hours ago.",
        )
        .waitFor();
      await page
        .locator(".diagnostics-facts")
        .getByText("Paused locally", { exact: true })
        .waitFor();
      await page
        .locator(".diagnostics-facts")
        .getByText("Last scheduled due before pause", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator(".diagnostics-facts")
          .getByText("Recorded provider not-before", { exact: true })
          .count(),
        0,
      );
      assert.equal(browserErrors.length, 2);

      providerNotBefore = DateTime.utc().plus({ hours: 24 }).toISO()!;
      await page.reload();
      const expectedProviderDeadline = DateTime.fromISO(providerNotBefore)
        .setZone(ZONE)
        .toLocaleString({
          ...DateTime.DATETIME_MED_WITH_WEEKDAY,
          timeZoneName: "short",
        });
      await page
        .locator('.alert[role="status"]')
        .getByText(/Recorded provider not-before:/)
        .waitFor();
      assert.equal(
        (await page.locator('.alert[role="status"]').innerText()).includes(
          "Not observed yet",
        ),
        false,
      );
      await diagnostics.click();
      const providerDeadlineFact = page
        .locator(".diagnostics-facts")
        .getByText("Recorded provider not-before", { exact: true })
        .locator("..");
      await providerDeadlineFact.waitFor();
      assert.equal(
        await providerDeadlineFact.locator("dd").innerText(),
        expectedProviderDeadline,
      );
      assert.equal(
        await page
          .locator(".diagnostics-facts")
          .getByText("Last scheduled due before pause", { exact: true })
          .count(),
        0,
      );
      refreshResponse = {
        status: "deferred",
        nextDueAt: null,
        providerNotBefore,
      };
      holdSources = true;
      const sourceRequest = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/sources",
      );
      await page.reload();
      await sourceRequest;
      await page
        .getByRole("button", { name: "Request a schedule refresh" })
        .click();
      await page
        .locator(".refresh-feedback")
        .getByText(/recorded provider not-before/)
        .waitFor();
      assert.equal(
        (await page.locator(".refresh-feedback").innerText()).includes(
          expectedProviderDeadline,
        ),
        true,
      );
      const releasedSource = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/sources",
      );
      releaseSources?.();
      holdSources = false;
      await releasedSource;
      assert.equal(browserErrors.length, 2);
    } finally {
      releaseSources?.();
      await browser.close();
      await server.close();
    }
  },
);
