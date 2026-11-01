import { DateTime } from "luxon";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Response,
} from "playwright";
import { writePrivateJson } from "../../apps/service/src/local-state.ts";
import {
  providerReadPermission,
  persistObservedRateLimit,
} from "../../apps/service/src/provider-access.ts";
import { retryAfterSeconds } from "../../apps/service/src/connectors/mccarren.ts";
import {
  readRenderedCells,
  requireMatchedReplay,
} from "../../apps/service/src/connectors/mccarren-browser.ts";
import {
  normalizeCells,
  parseScheduleQuery,
  parseScheduleSummary,
  type ProbeConfiguration,
} from "../../apps/service/src/connectors/mccarren-data.ts";
import { loadSession } from "../../apps/service/src/connectors/session.ts";
import { endpoint, observe } from "./response-observation.ts";

const PORTAL = "https://app.courtreserve.com/Online/Portal/Index/10243";
const SCHEDULE = "https://app.courtreserve.com/Online/Reservations/Index/10243";
const SCHEDULE_API =
  "https://backend.courtreserve.com/api/scheduler/member-expanded";
const ZONE = "America/New_York";

class ProbeError extends Error {}

async function replaySchedule(context: BrowserContext, observed: Response) {
  // Use the current observed read exactly once. Authentication values never leave
  // this process or appear in reports, errors, or copied example requests.
  parseScheduleQuery(observed.url());
  if (observed.request().method() !== "GET")
    throw new ProbeError("Schedule read method changed.");
  const headers = await observed.request().allHeaders();
  const response = await context.request.get(observed.url(), {
    headers: Object.fromEntries(
      Object.entries(headers).filter(([key]) =>
        ["authorization", "origin", "referer", "accept"].includes(
          key.toLowerCase(),
        ),
      ),
    ),
    maxRedirects: 0,
    timeout: 20000,
  });
  if (response.status() === 429) {
    persistObservedRateLimit({
      observedAt: new Date().toISOString(),
      retryAfterSeconds: retryAfterSeconds(response.headers()["retry-after"]),
    });
    throw new ProbeError(
      "Provider rate-limited the test. Stop and retry later.",
    );
  }
  if (!response.ok())
    return { state: "request-failed", status: response.status() };
  const original = await observed.json();
  const reproduced = await response.json();
  const summary = parseScheduleSummary(reproduced);
  const project = (payload: { Data: Record<string, unknown>[] }) =>
    payload.Data.map((row) =>
      JSON.stringify([
        row.Start,
        row.End,
        row.CourtId,
        row.ResourceUqId,
        row.IsBookingWindow,
        row.IsBlockingWindow,
        row.IsCourtClosed,
        row.IsOrgClosed,
      ]),
    ).sort();
  return {
    state:
      JSON.stringify(project(original)) === JSON.stringify(project(reproduced))
        ? "matched-browser-response"
        : "changed-since-browser-read",
    status: response.status(),
    rows: summary.rows,
  };
}

async function captureDay(
  page: Page,
  context: BrowserContext,
  response: Response,
  config: ProbeConfiguration,
) {
  if (!response.ok())
    throw new ProbeError(
      response.status() === 429
        ? "Provider rate-limited the test. Stop and retry later."
        : "Schedule request failed.",
    );
  const query = parseScheduleQuery(response.url());
  const api = parseScheduleSummary(await response.json());
  if (!api.complete)
    throw new ProbeError(
      "Schedule response is incomplete; no availability accepted.",
    );
  // The provider renders provisional Reserve controls while loading. Its own
  // busy indicators and disabled navigation must clear before accepting cells.
  const { cells, renderedReserveCount, loadingFinished } =
    await readRenderedCells(page, query.date);
  const openings = normalizeCells(cells, config, query.date);
  if (cells.length !== renderedReserveCount)
    throw new ProbeError(
      "Calendar selectors changed; Reserve controls do not match.",
    );
  const replay = await replaySchedule(context, response);
  try {
    requireMatchedReplay(replay);
  } catch {
    throw new ProbeError(
      "Schedule replay failed or changed. This test was not verified; retry later.",
    );
  }
  return {
    localDate: query.date,
    observedAt: new Date().toISOString(),
    coverage: {
      apiResponseComplete: api.complete,
      availabilityScope: "rendered-grid-only",
      completeDay: false,
    },
    apiRows: api.rows,
    renderedReserveCount,
    loadingFinished,
    replay,
    openings,
  };
}

async function testLive(days: number, headless: boolean): Promise<void> {
  const session = await loadSession();
  const browser = await chromium.launch({ headless });
  const started = Date.now();
  try {
    const context = await browser.newContext({
      timezoneId: ZONE,
      viewport: { width: 1440, height: 1000 },
      storageState: session,
    });
    const network = observe(context);
    const page = await context.newPage();
    const waitForSchedule = () =>
      page.waitForResponse((response) => endpoint(response) === SCHEDULE_API, {
        timeout: 30000,
      });
    let response: Response;
    try {
      [response] = await Promise.all([
        waitForSchedule(),
        page.goto(SCHEDULE, { waitUntil: "domcontentloaded", timeout: 60000 }),
      ]);
    } catch {
      throw new ProbeError(
        /cloudflare|attention required/i.test(await page.title())
          ? "Provider blocked this browser. Retry make test-live with the normal headed browser."
          : "No schedule response received. Reconnect with make connect if login expired.",
      );
    }
    await network.finish();
    if (
      network.state.failure ||
      !network.state.loggedIn ||
      !network.state.organizationMember ||
      !network.state.configuration
    ) {
      throw new ProbeError(
        "McCarren authentication or schedule configuration was not verified. Run make connect.",
      );
    }
    const partitions = [];
    for (let index = 0; index < days; index++) {
      const day = await captureDay(
        page,
        context,
        response,
        network.state.configuration,
      );
      partitions.push(day);
      if (index + 1 < days) {
        [response] = await Promise.all([
          waitForSchedule(),
          page.getByRole("button", { name: "Next day", exact: true }).click(),
        ]);
        const expected = DateTime.fromISO(day.localDate, { zone: ZONE })
          .plus({ days: 1 })
          .toISODate();
        if (parseScheduleQuery(response.url()).date !== expected)
          throw new ProbeError(
            "Next-day request did not match the requested local date.",
          );
      }
    }
    const result = {
      state: "live-read-verified",
      organization: "10243",
      timeZone: ZONE,
      sessionReused: true,
      browserMode: headless ? "headless" : "headed",
      observedAt: new Date().toISOString(),
      elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
      observedReadRequests: network.state.requests,
      replayRequests: partitions.length,
      configuration: network.state.configuration,
      partitions,
      note: "Reserve start markers only. Duration, price, eligibility, and full-day coverage remain unverified.",
    };
    await writePrivateJson("live-result.json", result);
    await writePrivateJson("test-status.json", {
      state: result.state,
      attemptedAt: result.observedAt,
    });
    console.log(
      JSON.stringify(
        {
          ...result,
          partitions: result.partitions.map((partition) => ({
            ...partition,
            openingCount: partition.openings.length,
            openings: partition.openings.slice(0, 5),
          })),
          report: ".local/mccarren/live-result.json (all extracted markers)",
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

async function inspect(headless: boolean): Promise<void> {
  const browser = await chromium.launch({ headless });
  try {
    const page = await browser.newPage({ timezoneId: ZONE });
    const portalResponse = await page.goto(PORTAL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    if (portalResponse?.status() === 429) {
      persistObservedRateLimit({
        observedAt: new Date().toISOString(),
        retryAfterSeconds: retryAfterSeconds(
          portalResponse.headers()["retry-after"],
        ),
      });
      throw new ProbeError(
        "CourtReserve is rate limited; wait for its retry deadline.",
      );
    }
    await page.waitForTimeout(12000);
    const state = /cloudflare|attention required/i.test(await page.title())
      ? "provider-blocked"
      : /\/Account\/Login\/10243/.test(new URL(page.url()).pathname)
        ? "needs-login"
        : "public-shell-only";
    console.log(
      JSON.stringify({ state, authenticated: false, availability: "unknown" }),
    );
    if (state === "provider-blocked") process.exitCode = 2;
  } finally {
    await browser.close();
  }
}

try {
  const [command, ...options] = process.argv.slice(2);
  const permission = providerReadPermission();
  if (!permission.allowed) throw new ProbeError(permission.message);
  if (
    options.some(
      (option) =>
        !["--headless", "--headed", "--days=1", "--days=2"].includes(option),
    )
  )
    throw new ProbeError(
      "Unknown option. Use --headless or --days=1/--days=2.",
    );
  if (command === "inspect") await inspect(options.includes("--headless"));
  else if (command === "test-live" || command === "check-session")
    await testLive(
      options.includes("--days=1") ? 1 : 2,
      options.includes("--headless"),
    );
  else
    throw new ProbeError(
      "Use inspect or test-live [--headless] [--days=1|--days=2].",
    );
} catch (error) {
  const message =
    error instanceof ProbeError
      ? error.message
      : "McCarren check failed. Provider data was not accepted; reconnect or inspect the browser manually.";
  console.error(message);
  if (["test-live", "check-session"].includes(process.argv[2] ?? "")) {
    await writePrivateJson("test-status.json", {
      state: "failed",
      attemptedAt: new Date().toISOString(),
      error: message,
    }).catch(() => {});
  }
  process.exitCode = 1;
}
