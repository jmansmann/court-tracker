import { DateTime } from "luxon";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
  type Request,
} from "playwright";
import {
  BOOKING_URL,
  TIME_ZONE,
  dateRange,
  type CollectionOptions,
  type CollectionSummary,
  type FailureCode,
  type Opening,
  type PartitionResult,
  type ScheduleConnector,
  type ConnectorDiagnostic,
} from "../../../../packages/contracts/src/index.ts";
import { readFullDaySchedule, readRenderedCells } from "./mccarren-browser.ts";
import {
  normalizeCells,
  parseConfiguration,
  parseScheduleQuery,
  parseScheduleSummary,
  type ProbeConfiguration,
} from "./mccarren-data.ts";
import { loadSession } from "./session.ts";

const SCHEDULE = BOOKING_URL;
const NAVIGATION =
  "https://app.courtreserve.com/Online/Portal/PortalNavigation/10243";
const CONFIGURATION =
  "https://app.courtreserve.com/Online/Reservations/Bookings/10243";
const SCHEDULE_API =
  "https://backend.courtreserve.com/api/scheduler/member-expanded";
const MAX_RETRY_AFTER_SECONDS = 86_400;

class ConnectorFailure extends Error {
  readonly code: FailureCode;
  readonly retryAfterSeconds?: number;
  readonly diagnostic?: ConnectorDiagnostic;

  constructor(
    code: FailureCode,
    message: string,
    retryAfterSeconds?: number,
    diagnostic?: ConnectorDiagnostic,
  ) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.diagnostic = diagnostic;
  }
}

interface NetworkState {
  loggedIn: boolean;
  organizationMember: boolean;
  configuration?: ProbeConfiguration;
  failure?: ConnectorFailure;
  requests: number;
  failedScheduleRequest?: Request;
}

interface ReadObserver {
  state: NetworkState;
  finish(): Promise<void>;
  reset(): void;
  raceFailure<T>(operation: Promise<T>): Promise<T>;
}

export interface McCarrenConnectorOptions {
  headless?: boolean;
  loadSession?: typeof loadSession;
  createContext?: (browser: Browser) => Promise<BrowserContext>;
  probeFailedRead?: (
    context: BrowserContext,
    request: Request,
  ) => Promise<{ status: number; retryAfterSeconds?: number } | undefined>;
  keepOpen?: boolean;
}

export interface McCarrenDateMetric {
  localDate: string;
  apiRows: number;
  apiTotal: number;
  renderedMarkers: number;
  viewportCount: number;
  coverageStartUtc: string;
  coverageEndUtc: string;
}

function endpoint(response: Response): string {
  try {
    const url = new URL(response.url());
    return url.origin + url.pathname;
  } catch {
    return "";
  }
}

function safeFailure(
  code: FailureCode,
  message: string,
  diagnostic?: ConnectorDiagnostic,
): ConnectorFailure {
  return new ConnectorFailure(code, message, undefined, diagnostic);
}

function diagnosticFor(
  url: string,
  kind: ConnectorDiagnostic["kind"],
  httpStatus?: number,
): ConnectorDiagnostic {
  const endpoint = new URL(url).origin + new URL(url).pathname;
  const target =
    endpoint === NAVIGATION
      ? "portal-navigation"
      : endpoint === CONFIGURATION
        ? "schedule-configuration"
        : "schedule-data";
  return {
    stage:
      target === "portal-navigation"
        ? "navigation"
        : target === "schedule-configuration"
          ? "configuration"
          : "schedule",
    kind,
    endpoint: target,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function httpFailure(
  status: number,
  diagnostic: ConnectorDiagnostic,
  retry?: number,
): ConnectorFailure {
  if (status === 429)
    return new ConnectorFailure(
      "rate-limited",
      "CourtReserve rate-limited schedule access. Collection is cooling down; reconnecting does not clear an IP limit.",
      retry ?? 3600,
      diagnostic,
    );
  if (status === 401 || status === 403)
    return new ConnectorFailure(
      "needs-login",
      "McCarren authentication is required. Reconnect with make connect.",
      undefined,
      diagnostic,
    );
  return new ConnectorFailure(
    "unavailable",
    "CourtReserve returned an error for the schedule read.",
    undefined,
    diagnostic,
  );
}

export function isValidatedFailedScheduleRead(request: Request): boolean {
  if (request.method() !== "GET" || !request.failure()) return false;
  try {
    parseScheduleQuery(request.url());
    return true;
  } catch {
    return false;
  }
}

export async function confirmFailedScheduleRead(
  context: BrowserContext,
  request: Request,
): Promise<
  | { status: number; retryAfterSeconds?: number; cloudflareResponse?: boolean }
  | undefined
> {
  // CORS can hide an upstream 429 from the browser's Response event. Confirm at
  // most once using the exact observed, validated GET; never log its auth data.
  if (!isValidatedFailedScheduleRead(request)) return undefined;
  try {
    parseScheduleQuery(request.url());
    const headers = await request.allHeaders();
    const response = await context.request.get(request.url(), {
      headers: Object.fromEntries(
        Object.entries(headers).filter(([key]) =>
          ["authorization", "origin", "referer", "accept"].includes(key),
        ),
      ),
      maxRedirects: 0,
      timeout: 10000,
    });
    try {
      return {
        status: response.status(),
        cloudflareResponse:
          response.headers()["server"]?.toLowerCase() === "cloudflare",
        retryAfterSeconds: retryAfterSeconds(response.headers()["retry-after"]),
      };
    } finally {
      await response.dispose();
    }
  } catch {
    return undefined;
  }
}

export function retryAfterSeconds(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined;
  let seconds: number;
  if (/^\d+$/.test(value.trim())) {
    seconds = Number(value.trim());
  } else {
    const date = Date.parse(value);
    if (!Number.isFinite(date)) return undefined;
    seconds = Math.ceil((date - Date.now()) / 1000);
  }
  if (seconds <= 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

function classifyHttpFailure(response: Response): ConnectorFailure {
  return httpFailure(
    response.status(),
    diagnosticFor(response.url(), "http-error", response.status()),
    retryAfterSeconds(response.headers()["retry-after"]),
  );
}

function checkedAt(): string {
  return DateTime.utc().toISO({ suppressMilliseconds: true }) as string;
}

function providerCookieUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "courtreserve.com" ||
        parsed.hostname.endsWith(".courtreserve.com"))
    );
  } catch {
    return false;
  }
}

function listenForReads(context: BrowserContext): {
  state: NetworkState;
  finish(): Promise<void>;
  reset(): void;
  raceFailure<T>(operation: Promise<T>): Promise<T>;
} {
  const pending = new Set<Promise<void>>();
  const failures = new Set<(failure: ConnectorFailure) => void>();
  const state: NetworkState = {
    loggedIn: false,
    organizationMember: false,
    requests: 0,
  };
  const setFailure = (failure: ConnectorFailure) => {
    state.failure = failure;
    failures.forEach((notify) => notify(failure));
  };
  context.on("request", (request) => {
    const url = request.url();
    if (
      providerCookieUrl(url) &&
      [NAVIGATION, CONFIGURATION, SCHEDULE_API].includes(
        (() => {
          try {
            const parsed = new URL(url);
            return parsed.origin + parsed.pathname;
          } catch {
            return "";
          }
        })(),
      )
    ) {
      state.requests++;
    }
  });
  const capture = async (response: Response): Promise<void> => {
    const url = endpoint(response);
    if (![NAVIGATION, CONFIGURATION, SCHEDULE_API].includes(url)) return;
    if (!response.ok()) {
      setFailure(classifyHttpFailure(response));
      return;
    }
    try {
      if (url === NAVIGATION) {
        const payload = await response.json();
        state.loggedIn =
          payload?.isValid === true &&
          payload?.data?.Member?.IsLoggedIn === true;
        state.organizationMember = payload?.data?.Member?.IsOrgMember === true;
      } else if (url === CONFIGURATION) {
        state.configuration = parseConfiguration(await response.json());
      }
    } catch {
      setFailure(
        safeFailure(
          "parse-error",
          "McCarren returned an invalid schedule configuration.",
          diagnosticFor(response.url(), "invalid-payload", response.status()),
        ),
      );
    }
  };
  context.on("response", (response) => {
    const task = capture(response).catch(() => {
      setFailure(
        safeFailure("unavailable", "Unable to read McCarren provider data."),
      );
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  context.on("requestfailed", (request) => {
    const target = (() => {
      try {
        const url = new URL(request.url());
        return url.origin + url.pathname;
      } catch {
        return "";
      }
    })();
    if (![NAVIGATION, CONFIGURATION, SCHEDULE_API].includes(target)) return;
    const network = request.failure()?.errorText ?? "";
    const diagnostic = diagnosticFor(request.url(), "network-error");
    if (/^net::ERR_[A-Z0-9_]+$/.test(network)) diagnostic.networkCode = network;
    setFailure(
      safeFailure(
        "unavailable",
        "The provider schedule request failed in the browser; availability was not accepted.",
        diagnostic,
      ),
    );
    if (target === SCHEDULE_API && request.method() === "GET")
      state.failedScheduleRequest = request;
  });
  return {
    state,
    async finish() {
      await Promise.all([...pending]);
    },
    reset() {
      state.loggedIn = false;
      state.organizationMember = false;
      state.configuration = undefined;
      state.failure = undefined;
      state.failedScheduleRequest = undefined;
    },
    async raceFailure<T>(operation: Promise<T>): Promise<T> {
      let notify!: (failure: ConnectorFailure) => void;
      const failure = new Promise<never>((_, reject) => {
        notify = reject;
      });
      failures.add(notify);
      if (state.failure) notify(state.failure);
      try {
        return await Promise.race([operation, failure]);
      } finally {
        failures.delete(notify);
      }
    },
  };
}

function responseFailure(response: Response): ConnectorFailure {
  return classifyHttpFailure(response);
}

function openingFromMarker(
  marker: ReturnType<typeof normalizeCells>[number],
  observedAt: string,
): Opening {
  return {
    id: `${marker.courtId}:${marker.startUtc}`,
    sourceId: "mccarren",
    courtId: marker.courtId,
    courtLabel: marker.courtLabel,
    localDate: marker.localDate,
    localTime: marker.localTime,
    startUtc: marker.startUtc,
    endUtc: null,
    kind: "reserve-start",
    providerLabel: "Reserve",
    durationMinutes: null,
    price: null,
    eligibility: "unknown",
    bookingUrl: BOOKING_URL,
    observedAt,
  };
}

function makeFailurePartition(
  localDate: string,
  failure: ConnectorFailure,
): PartitionResult {
  return {
    state: "failed",
    localDate,
    checkedAt: checkedAt(),
    errorCode: failure.code,
    message: failure.message,
    ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
    ...(failure.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: failure.retryAfterSeconds }),
  };
}

function startupFailure(
  page: Page,
  network: NetworkState,
  cloudflare = false,
): ConnectorFailure {
  if (network.failure) return network.failure;
  const url = page.url();
  if (/\/Account\/Login\//.test(url)) {
    return safeFailure(
      "needs-login",
      "McCarren login is required. Reconnect with make connect.",
    );
  }
  if (cloudflare || /cloudflare|attention required/i.test(page.url())) {
    return safeFailure(
      "provider-blocked",
      "McCarren blocked this browser session; no schedule was accepted.",
    );
  }
  return safeFailure(
    "unavailable",
    "McCarren schedule could not be loaded. Check the provider and saved session.",
  );
}

/** Read-only CourtReserve connector using the signed-in, full-day scheduler DOM. */
export class McCarrenConnector implements ScheduleConnector {
  private readonly headless: boolean;
  private readonly sessionLoader: typeof loadSession;
  private readonly contextFactory: (
    browser: Browser,
  ) => Promise<BrowserContext>;
  private readonly failedReadProbe: NonNullable<
    McCarrenConnectorOptions["probeFailedRead"]
  >;
  private currentSignal?: AbortSignal;
  private probedFailure = false;
  private readonly keepOpen: boolean;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private network?: ReadObserver;
  private initialization?: Promise<void>;
  private readonly dateMetrics: McCarrenDateMetric[] = [];

  constructor(options: McCarrenConnectorOptions = {}) {
    this.headless = options.headless ?? false;
    this.sessionLoader = options.loadSession ?? loadSession;
    this.failedReadProbe = options.probeFailedRead ?? confirmFailedScheduleRead;
    this.keepOpen = options.keepOpen ?? false;
    this.contextFactory =
      options.createContext ??
      ((browser) =>
        browser.newContext({
          timezoneId: TIME_ZONE,
          viewport: { width: 1440, height: 1000 },
        }));
  }

  async collect(options: CollectionOptions): Promise<CollectionSummary> {
    this.currentSignal = options.signal;
    this.probedFailure = false;
    const dates = dateRange(options.from, options.days);
    this.dateMetrics.length = 0;
    const startedAt = Date.now();
    let attemptedDates = 0;
    let completedDates = 0;
    const requestsBefore = this.network?.state.requests ?? 0;
    let requestObserver: ReadObserver | undefined;
    let terminalFailure: ConnectorFailure | undefined;
    const onAbort = () => {
      void this.closeResources();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (options.signal?.aborted) {
        throw safeFailure("incomplete", "McCarren collection was cancelled.");
      }
      await this.ensureInitialized();
      requestObserver = this.network;
      let scheduleResponse = await this.openSchedule();
      const page = this.page;
      const network = this.network;
      if (!page || !network) {
        throw safeFailure("unavailable", "McCarren browser is unavailable.");
      }
      await network.finish();
      if (
        network.state.failure ||
        !network.state.loggedIn ||
        !network.state.organizationMember ||
        !network.state.configuration
      ) {
        throw (
          network.state.failure ??
          safeFailure(
            "needs-login",
            "McCarren login or organization access is not verified. Run make connect.",
          )
        );
      }

      let initialQuery = parseScheduleQuery(scheduleResponse.url());
      const today = DateTime.now().setZone(TIME_ZONE).toISODate()!;
      // CourtReserve remembers the last viewed date in a reused browser context.
      // Reset through its normal navigation before starting another rolling cycle.
      if (initialQuery.date !== today) {
        [scheduleResponse] = await network.raceFailure(
          Promise.all([
            page.waitForResponse(
              (response) => endpoint(response) === SCHEDULE_API,
              { timeout: 30_000 },
            ),
            page.getByTestId("scheduler-today-btn").click({ timeout: 15_000 }),
          ]),
        );
        if (!scheduleResponse.ok()) throw classifyHttpFailure(scheduleResponse);
        initialQuery = parseScheduleQuery(scheduleResponse.url());
        if (initialQuery.date !== today)
          throw safeFailure(
            "incomplete",
            "McCarren did not return to today's schedule.",
          );
      }
      await readRenderedCells(page, initialQuery.date);
      scheduleResponse = await this.positionAtStart(
        page,
        scheduleResponse,
        options.from,
        network.state.configuration,
        dates.length,
        options.signal,
      );

      let currentScheduleResponse = scheduleResponse;
      for (let index = 0; index < dates.length; index++) {
        const date = dates[index]!;
        attemptedDates++;
        try {
          if (options.signal?.aborted) {
            throw safeFailure(
              "incomplete",
              "McCarren collection was cancelled.",
            );
          }
          const query = parseScheduleQuery(currentScheduleResponse.url());
          if (query.date !== date || query.organizationId !== 10243) {
            throw safeFailure(
              "incomplete",
              "McCarren returned a different local schedule date.",
            );
          }
          if (!currentScheduleResponse.ok()) {
            throw responseFailure(currentScheduleResponse);
          }
          let apiSummary: ReturnType<typeof parseScheduleSummary>;
          try {
            apiSummary = parseScheduleSummary(
              await currentScheduleResponse.json(),
            );
          } catch {
            throw safeFailure(
              "parse-error",
              "CourtReserve returned invalid schedule data; availability was not accepted.",
              diagnosticFor(
                currentScheduleResponse.url(),
                "invalid-payload",
                currentScheduleResponse.status(),
              ),
            );
          }
          if (!apiSummary.complete) {
            throw safeFailure(
              "incomplete",
              "McCarren schedule data was incomplete; no availability was accepted.",
            );
          }

          const configuration = network.state.configuration;
          const terminalDate = DateTime.now()
            .setZone(TIME_ZONE)
            .plus({ days: configuration.bookingDays })
            .toISODate();
          const fullDay = await readFullDaySchedule(
            page,
            date,
            configuration,
            30_000,
            { allowDisabledNext: date === terminalDate },
          ).catch(() => {
            throw safeFailure(
              "incomplete",
              "The complete provider grid could not be verified.",
              { stage: "grid", kind: "render-incomplete", endpoint: null },
            );
          });
          const markers = normalizeCells(fullDay.cells, configuration, date);
          if (network.state.failure) throw network.state.failure;
          const observedAt = checkedAt();
          const openings = markers.map((marker) =>
            openingFromMarker(marker, observedAt),
          );
          const partition: PartitionResult = {
            state: "complete",
            localDate: date,
            checkedAt: observedAt,
            coverageStartUtc: fullDay.coverageStartUtc,
            coverageEndUtc: fullDay.coverageEndUtc,
            openings,
            note: "Reserve start markers only; duration, price, and eligibility are unknown.",
          };
          this.dateMetrics.push({
            localDate: date,
            apiRows: apiSummary.rows,
            apiTotal: apiSummary.total,
            renderedMarkers: openings.length,
            viewportCount: fullDay.viewportCount,
            coverageStartUtc: fullDay.coverageStartUtc,
            coverageEndUtc: fullDay.coverageEndUtc,
          });
          await options.onPartition(partition);
          completedDates++;

          if (index + 1 < dates.length) {
            const nextButton = page.locator(
              "[data-testid='scheduler-next-btn']",
            );
            if (await nextButton.isDisabled()) {
              throw safeFailure(
                "unavailable",
                "McCarren has no posted next date in this schedule view.",
              );
            }
            const nextDate = dates[index + 1]!;
            const responsePromise = page.waitForResponse(
              (response) => endpoint(response) === SCHEDULE_API,
              { timeout: 30_000 },
            );
            try {
              const clickPromise = page
                .getByRole("button", { name: "Next day", exact: true })
                .click({ timeout: 10_000 });
              [, currentScheduleResponse] = await network.raceFailure(
                Promise.all([clickPromise, responsePromise]),
              );
            } catch {
              throw (
                network.state.failure ??
                safeFailure(
                  "incomplete",
                  "McCarren did not load the next requested schedule date.",
                  {
                    stage: "date-navigation",
                    kind: "timeout",
                    endpoint: "schedule-data",
                  },
                )
              );
            }
            const nextQuery = parseScheduleQuery(currentScheduleResponse.url());
            if (nextQuery.date !== nextDate) {
              throw safeFailure(
                "incomplete",
                "McCarren did not advance to the next requested local date.",
              );
            }
            if (!currentScheduleResponse.ok()) {
              throw responseFailure(currentScheduleResponse);
            }
          }
        } catch (error) {
          terminalFailure = await this.refineFailure(
            error instanceof ConnectorFailure
              ? error
              : (network.state.failure ??
                  safeFailure(
                    "incomplete",
                    "McCarren full-day schedule coverage could not be verified.",
                    {
                      stage: "grid",
                      kind: "render-incomplete",
                      endpoint: null,
                    },
                  )),
          );
          if (completedDates < attemptedDates) {
            await options.onPartition(
              makeFailurePartition(date, terminalFailure),
            );
          }
          for (const remainingDate of dates.slice(index + 1)) {
            await options.onPartition(
              makeFailurePartition(remainingDate, terminalFailure),
            );
          }
          break;
        }
      }
    } catch (error) {
      terminalFailure = await this.refineFailure(
        error instanceof ConnectorFailure
          ? error
          : options.signal?.aborted
            ? safeFailure("incomplete", "McCarren collection was cancelled.")
            : safeFailure(
                "unavailable",
                "McCarren browser or saved session is unavailable.",
                { stage: "collection", kind: "browser-error", endpoint: null },
              ),
      );
      for (const date of dates.slice(attemptedDates)) {
        await options.onPartition(makeFailurePartition(date, terminalFailure));
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.currentSignal = undefined;
      if (!this.keepOpen || terminalFailure) await this.closeResources();
    }

    return {
      attemptedDates,
      completedDates,
      elapsedMs: Date.now() - startedAt,
      requests: Math.max(
        0,
        (requestObserver?.state.requests ?? requestsBefore) - requestsBefore,
      ),
      ...(terminalFailure
        ? {
            terminalError: terminalFailure.code,
            message: terminalFailure.message,
            ...(terminalFailure.diagnostic
              ? { diagnostic: terminalFailure.diagnostic }
              : {}),
            ...(terminalFailure.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: terminalFailure.retryAfterSeconds }),
          }
        : {}),
    };
  }

  async close(): Promise<void> {
    const initializing = this.initialization;
    await this.closeResources();
    await initializing?.catch(() => {});
    await this.closeResources();
  }

  /** Safe, in-memory operational counts from the most recent collection. */
  get lastRunMetrics(): readonly McCarrenDateMetric[] {
    return this.dateMetrics.map((metric) => ({ ...metric }));
  }

  private async refineFailure(
    failure: ConnectorFailure,
  ): Promise<ConnectorFailure> {
    if (this.currentSignal?.aborted)
      return safeFailure(
        "incomplete",
        "Collection was cancelled; cached availability is retained.",
        { stage: "collection", kind: "cancelled", endpoint: null },
      );
    const request = this.network?.state.failedScheduleRequest;
    if (
      failure.diagnostic?.kind !== "network-error" ||
      !request ||
      !this.context ||
      this.probedFailure
    )
      return failure;
    this.probedFailure = true;
    this.network!.state.requests++;
    const confirmed = await this.failedReadProbe(this.context, request);
    if (!confirmed) return failure;
    const diagnostic = diagnosticFor(
      request.url(),
      "http-error",
      confirmed.status,
    );
    if (failure.diagnostic?.networkCode)
      diagnostic.networkCode = failure.diagnostic.networkCode;
    if (confirmed.status === 429 || confirmed.status >= 400)
      return httpFailure(
        confirmed.status,
        diagnostic,
        confirmed.retryAfterSeconds,
      );
    return safeFailure(
      "unavailable",
      "The browser could not load schedule data; apparent Reserve cells are not verified.",
      { ...diagnostic, kind: "network-error" },
    );
  }

  private async ensureInitialized(): Promise<void> {
    if (
      this.page &&
      !this.page.isClosed() &&
      this.browser?.isConnected() &&
      this.context &&
      this.network
    )
      return;
    if (this.browser || this.context) await this.closeResources();
    if (!this.initialization) {
      this.initialization = this.initialize();
    }
    try {
      await this.initialization;
    } finally {
      this.initialization = undefined;
    }
  }

  private async initialize(): Promise<void> {
    try {
      this.browser = await chromium.launch({ headless: this.headless });
      this.context = await this.contextFactory(this.browser);
      this.network = listenForReads(this.context);
      this.page = await this.context.newPage();
    } catch (error) {
      await this.closeResources();
      if (error instanceof ConnectorFailure) throw error;
      throw safeFailure(
        "unavailable",
        "McCarren browser or saved session is unavailable.",
      );
    }
  }

  private async openSchedule(): Promise<Response> {
    const page = this.page;
    const context = this.context;
    const network = this.network;
    if (!page || !context || !network) {
      throw safeFailure("unavailable", "McCarren browser is unavailable.");
    }
    let session: Awaited<ReturnType<typeof loadSession>>;
    try {
      session = await this.sessionLoader();
    } catch (error) {
      const message =
        error instanceof Error &&
        /No saved McCarren session|Invalid saved session/.test(error.message)
          ? error.message
          : "Unable to load saved McCarren session. Reconnect with make connect.";
      throw safeFailure("needs-login", message, {
        stage: "session",
        kind: "authentication",
        endpoint: null,
      });
    }
    network.reset();
    await context.clearCookies();
    await context.addCookies(session.cookies);
    const schedule = page.waitForResponse(
      (response) => endpoint(response) === SCHEDULE_API,
      { timeout: 30_000 },
    );
    const navigation = page.waitForResponse(
      (response) => endpoint(response) === NAVIGATION,
      { timeout: 30_000 },
    );
    const configuration = page.waitForResponse(
      (response) => endpoint(response) === CONFIGURATION,
      { timeout: 30_000 },
    );
    try {
      const [responses] = await network.raceFailure(
        Promise.all([
          Promise.all([schedule, navigation, configuration]),
          page.goto(SCHEDULE, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          }),
        ]),
      );
      const [scheduleResponse, navigationResponse, configurationResponse] =
        responses;
      if (!scheduleResponse.ok()) throw classifyHttpFailure(scheduleResponse);
      if (!navigationResponse.ok()) {
        throw classifyHttpFailure(navigationResponse);
      }
      if (!configurationResponse.ok()) {
        throw classifyHttpFailure(configurationResponse);
      }
      await network.finish();
      if (network.state.failure) throw network.state.failure;
      if (
        !network.state.loggedIn ||
        !network.state.organizationMember ||
        !network.state.configuration
      ) {
        throw startupFailure(
          page,
          network.state,
          /cloudflare|attention required/i.test(
            await page.title().catch(() => ""),
          ),
        );
      }
      const currentUrl = new URL(page.url());
      if (
        currentUrl.origin !== "https://app.courtreserve.com" ||
        !/\/10243$/.test(currentUrl.pathname)
      ) {
        throw safeFailure(
          "needs-login",
          "McCarren organization access is not verified. Run make connect.",
        );
      }
      return scheduleResponse;
    } catch (error) {
      throw await this.refineFailure(
        error instanceof ConnectorFailure
          ? error
          : startupFailure(
              page,
              network.state,
              /cloudflare|attention required/i.test(
                await page.title().catch(() => ""),
              ),
            ),
      );
    }
  }

  private async closeResources(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    this.context = undefined;
    this.browser = undefined;
    this.page = undefined;
    this.network = undefined;
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  private async positionAtStart(
    page: Page,
    firstResponse: Response,
    requestedDate: string,
    configuration: ProbeConfiguration,
    requestedDays: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const startQuery = parseScheduleQuery(firstResponse.url());
    const today = DateTime.now().setZone(TIME_ZONE).toISODate() as string;
    if (startQuery.date !== today) {
      throw safeFailure(
        "incomplete",
        "McCarren opened a different local date than today; requested scope is not verified.",
      );
    }
    const requested = DateTime.fromISO(requestedDate, { zone: TIME_ZONE });
    const offset = Math.round(
      requested.diff(DateTime.fromISO(today, { zone: TIME_ZONE }), "days").days,
    );
    if (
      offset < 0 ||
      offset > configuration.bookingDays ||
      offset + requestedDays - 1 > configuration.bookingDays ||
      requestedDays > 8
    ) {
      throw safeFailure(
        "unavailable",
        "Requested McCarren dates are outside the configured posted window.",
      );
    }
    let response = firstResponse;
    for (let index = 0; index < offset; index++) {
      if (signal?.aborted) {
        throw safeFailure("incomplete", "McCarren collection was cancelled.");
      }
      const fromDate = DateTime.fromISO(today, { zone: TIME_ZONE })
        .plus({ days: index })
        .toISODate() as string;
      const nextDate = DateTime.fromISO(fromDate, { zone: TIME_ZONE })
        .plus({ days: 1 })
        .toISODate() as string;
      await readRenderedCells(page, fromDate);
      const nextButton = page.locator("[data-testid='scheduler-next-btn']");
      if (await nextButton.isDisabled()) {
        throw safeFailure(
          "unavailable",
          "Requested McCarren date is not posted in the schedule view.",
        );
      }
      const responsePromise = page.waitForResponse(
        (candidate) => endpoint(candidate) === SCHEDULE_API,
        { timeout: 30_000 },
      );
      const clickPromise = page
        .getByRole("button", { name: "Next day", exact: true })
        .click({ timeout: 10_000 });
      try {
        [, response] = await this.network!.raceFailure(
          Promise.all([clickPromise, responsePromise]),
        );
      } catch {
        throw safeFailure(
          "incomplete",
          "McCarren did not load the requested local date.",
        );
      }
      if (!response.ok()) throw responseFailure(response);
      if (parseScheduleQuery(response.url()).date !== nextDate) {
        throw safeFailure(
          "incomplete",
          "McCarren did not advance to the requested local date.",
        );
      }
    }
    return response;
  }
}
