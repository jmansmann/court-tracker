import { chromium, type Response } from "playwright";
import { loadSession } from "../../apps/service/src/connectors/session.ts";
import { BOOKING_URL, TIME_ZONE } from "../../packages/contracts/src/index.ts";
import {
  providerReadPermission,
  persistObservedRateLimit,
} from "../../apps/service/src/provider-access.ts";
import {
  confirmFailedScheduleRead,
  isValidatedFailedScheduleRead,
  retryAfterSeconds,
} from "../../apps/service/src/connectors/mccarren.ts";
import { parseScheduleQuery } from "../../apps/service/src/connectors/mccarren-data.ts";

const permission = providerReadPermission();
if (!permission.allowed) {
  console.error(permission.message);
  process.exit(2);
}

// Explicit opt-in operational probe. No raw URLs, headers, bodies, browser text,
// cookies, or console messages are printed or retained.
function label(url: string): string | null {
  const parsed = new URL(url);
  if (
    parsed.origin === "https://app.courtreserve.com" &&
    parsed.pathname === "/Online/Portal/PortalNavigation/10243"
  )
    return "navigation";
  if (
    parsed.origin === "https://app.courtreserve.com" &&
    parsed.pathname === "/Online/Reservations/Bookings/10243"
  )
    return "configuration";
  if (
    parsed.origin === "https://backend.courtreserve.com" &&
    parsed.pathname.startsWith("/api/scheduler/")
  )
    return "schedule";
  return null;
}
function summarize(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null)
    return { payload: "not-an-object" };
  const payload = value as Record<string, unknown>;
  return {
    dataArray: Array.isArray(payload.Data),
    rows: Array.isArray(payload.Data) ? payload.Data.length : null,
    total: typeof payload.Total === "number" ? payload.Total : null,
    errorsPresent: payload.Errors !== undefined && payload.Errors !== null,
    valid:
      typeof payload.IsValid === "boolean"
        ? payload.IsValid
        : typeof payload.isValid === "boolean"
          ? payload.isValid
          : null,
  };
}

const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext({
    storageState: await loadSession(),
    timezoneId: TIME_ZONE,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const requests: Record<string, unknown>[] = [];
  const pending = new Set<Promise<void>>();
  let scheduleResponse: Response | undefined;
  let scheduleRequest: import("playwright").Request | undefined;
  let corsErrors = 0;
  let otherConsoleErrors = 0;
  let persistenceFailed = false;
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/cors|cross-origin/i.test(message.text())) corsErrors++;
    else otherConsoleErrors++;
  });
  page.on("request", (request) => {
    try {
      if (request.method() === "GET") {
        parseScheduleQuery(request.url());
        scheduleRequest = request;
      }
    } catch {}
  });
  page.on("requestfailed", (request) => {
    const endpoint = label(request.url());
    if (!endpoint) return;
    const raw = request.failure()?.errorText ?? "";
    requests.push({
      endpoint,
      event: "request-failed",
      networkCode: /^net::ERR_[A-Z0-9_]+$/.test(raw) ? raw : "unclassified",
    });
  });
  page.on("response", (response) => {
    const endpoint = label(response.url());
    if (!endpoint) return;
    if (endpoint === "schedule") {
      try {
        parseScheduleQuery(response.url());
        if (response.request().method() === "GET") scheduleResponse = response;
      } catch {}
    }
    const record: Record<string, unknown> = {
      endpoint,
      event: "response",
      status: response.status(),
      json: (response.headers()["content-type"] ?? "").includes("json"),
      corsAllowsApp:
        response.headers()["access-control-allow-origin"] ===
        "https://app.courtreserve.com",
    };
    requests.push(record);
    if (response.status() === 429) {
      try {
        persistObservedRateLimit({
          observedAt: new Date().toISOString(),
          retryAfterSeconds: retryAfterSeconds(
            response.headers()["retry-after"],
          ),
          diagnostic: {
            stage:
              endpoint === "navigation"
                ? "navigation"
                : endpoint === "configuration"
                  ? "configuration"
                  : "schedule",
            kind: "http-error",
            endpoint:
              endpoint === "navigation"
                ? "portal-navigation"
                : endpoint === "configuration"
                  ? "schedule-configuration"
                  : "schedule-data",
            httpStatus: 429,
          },
        });
      } catch {
        persistenceFailed = true;
      }
    }
    const task = (async () => {
      try {
        const data = await response.json();
        Object.assign(record, summarize(data));
        if (endpoint === "navigation") {
          record.loggedIn = data?.data?.Member?.IsLoggedIn === true;
          record.organizationMember = data?.data?.Member?.IsOrgMember === true;
        }
      } catch {
        record.payload = "unreadable-or-non-json";
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await page.goto(BOOKING_URL, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(12000);
  await Promise.all([...pending]);
  if (persistenceFailed)
    throw new Error("Provider cooldown could not be recorded");
  let replay: Record<string, unknown> = { attempted: false };
  if (
    process.argv.includes("--http") &&
    scheduleRequest &&
    isValidatedFailedScheduleRead(scheduleRequest)
  ) {
    try {
      const result = await confirmFailedScheduleRead(context, scheduleRequest);
      replay = result
        ? { attempted: true, ...result }
        : { attempted: true, state: "request-failed" };
      if (result?.status === 429)
        persistObservedRateLimit({
          observedAt: new Date().toISOString(),
          retryAfterSeconds: result.retryAfterSeconds,
          diagnostic: {
            stage: "schedule",
            kind: "http-error",
            endpoint: "schedule-data",
            httpStatus: 429,
          },
          requests: requests.length + 1,
        });
    } catch {
      if (replay.status === 429) persistenceFailed = true;
      replay = { attempted: true, state: "request-failed" };
    }
  }
  if (persistenceFailed)
    throw new Error("Provider cooldown could not be recorded");
  console.log(
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        browser: "headed",
        loginPage: /\/Account\/Login\//.test(new URL(page.url()).pathname),
        challenge: /cloudflare|attention required/i.test(await page.title()),
        requests,
        corsErrors,
        otherConsoleErrors,
        busyIndicators: await page
          .locator('[data-testid="scheduler-page"] [aria-busy="true"]')
          .count(),
        renderedReserveControls: await page
          .getByTestId("reserve-slot-btn")
          .count(),
        scheduleResponseObserved: scheduleResponse !== undefined,
        replay,
      },
      null,
      2,
    ),
  );
  if (
    !scheduleResponse?.ok() ||
    requests.some(
      (record) =>
        record.endpoint === "schedule" && record.event === "request-failed",
    )
  )
    process.exitCode = 2;
} catch {
  console.error(
    "The bounded provider inspection failed; no private diagnostics were printed.",
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
