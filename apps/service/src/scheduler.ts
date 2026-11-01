import { DateTime } from "luxon";
import { randomUUID } from "node:crypto";
import {
  BOOKING_URL,
  TIME_ZONE,
  dateRange,
  localToday,
  ConnectorDiagnosticSchema,
  PartitionResultSchema,
  type ConnectorDiagnostic,
  type RefreshRun,
  type CollectionSummary,
  type FailureCode,
  type RefreshResponse,
  type ScheduleConnector,
  type SourceStatus,
} from "../../../packages/contracts/src/index.ts";
import { ScheduleStore } from "./store.ts";

const MAX_RATE_LIMIT_SECONDS = 86_400;
const MAX_TRANSIENT_SECONDS = 3_600;
const DEFAULT_CADENCE_SECONDS = 900;
const SESSION_CHECK_SECONDS = 60;
const STOP_WAIT_MS = 10_000;

export interface RefreshSchedulerOptions {
  store: ScheduleStore;
  connector: ScheduleConnector;
  sessionRevision: () => Promise<string | null>;
  collectionEnabled?: boolean;
  cadenceSeconds?: number;
  now?: () => number;
  onEvent?: (event: Record<string, unknown>) => void;
  collectionTimeoutMs?: number;
}

function instant(milliseconds: number): string {
  return DateTime.fromMillis(milliseconds, { zone: "utc" }).toISO({
    suppressMilliseconds: true,
  }) as string;
}

function baseStatus(cadenceSeconds: number): SourceStatus {
  return {
    id: "mccarren",
    name: "McCarren Tennis Center",
    timeZone: TIME_ZONE,
    bookingUrl: BOOKING_URL,
    transport: "browser-dom",
    health: "never-connected",
    message: "No McCarren session is connected.",
    sessionPresent: false,
    isRefreshing: false,
    collectionPaused: false,
    cadenceSeconds,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: null,
    providerNotBefore: null,
  };
}

function safeSummaryError(error: unknown): FailureCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === "needs-login" ||
      code === "provider-blocked" ||
      code === "rate-limited" ||
      code === "incomplete" ||
      code === "parse-error" ||
      code === "unavailable"
    ) {
      return code;
    }
  }
  return "unavailable";
}

function backoffSeconds(
  failure: FailureCode,
  failures: number,
  cadenceSeconds: number,
  retryAfterSeconds?: number,
): number {
  const exponent = Math.min(30, Math.max(0, failures - 1));
  const base = cadenceSeconds * 2 ** exponent;
  if (failure === "rate-limited") {
    return Math.min(
      MAX_RATE_LIMIT_SECONDS,
      Math.max(base, retryAfterSeconds ?? 0),
    );
  }
  return Math.min(MAX_TRANSIENT_SECONDS, base);
}

function timedOut<T>(promise: Promise<T>, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    const finish = () => {
      clearTimeout(timeout);
      resolve();
    };
    void promise.then(finish, finish);
  });
}

/** One-at-a-time refresh loop for the eight New York-local posted dates. */
export class RefreshScheduler {
  private readonly store: ScheduleStore;
  private readonly connector: ScheduleConnector;
  private readonly getSessionRevision: () => Promise<string | null>;
  private readonly collectionEnabled: boolean;
  private readonly cadenceSeconds: number;
  private readonly now: () => number;
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private abortController?: AbortController;
  private started = false;
  private stopped = false;
  private sessionRevision: string | null | undefined;
  private pausedRevision: string | null | undefined;
  private failures = 0;
  private closePromise?: Promise<void>;
  private readonly onEvent: (event: Record<string, unknown>) => void;
  private readonly collectionTimeoutMs: number;
  private quarantined = false;
  private providerNotBefore: string | null;

  constructor(options: RefreshSchedulerOptions) {
    const cadence = options.cadenceSeconds ?? DEFAULT_CADENCE_SECONDS;
    if (!Number.isInteger(cadence) || cadence < 60) {
      throw new Error(
        "Refresh cadence must be an integer of at least 60 seconds",
      );
    }
    this.store = options.store;
    this.connector = options.connector;
    this.getSessionRevision = options.sessionRevision;
    this.collectionEnabled = options.collectionEnabled ?? true;
    this.cadenceSeconds = cadence;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent ?? (() => {});
    this.collectionTimeoutMs = options.collectionTimeoutMs ?? 180000;
    if (
      !Number.isFinite(this.collectionTimeoutMs) ||
      this.collectionTimeoutMs < 1
    )
      throw new Error("Invalid collection timeout");
    this.store.interruptRuns(instant(this.now()));
    this.pausedRevision = this.store.readPausedSessionRevision();

    const previous = this.store.getStatus();
    this.providerNotBefore = this.store.readProviderNotBefore();
    if (
      previous?.health === "rate-limited" &&
      previous.nextDueAt &&
      Date.parse(previous.nextDueAt) >
        Date.parse(this.providerNotBefore ?? "1970-01-01T00:00:00Z")
    ) {
      this.providerNotBefore = previous.nextDueAt;
      this.store.setProviderNotBefore(this.providerNotBefore);
    }
    if (previous?.isRefreshing) {
      this.store.setStatus({
        ...previous,
        health: previous.lastSuccessAt ? "partial" : "error",
        message: "The previous refresh was interrupted.",
        isRefreshing: false,
      });
    }
    if (previous && previous.cadenceSeconds !== cadence)
      this.store.setStatus({ ...this.status(), cadenceSeconds: cadence });
    const current = this.status();
    const collectionPaused = !this.collectionEnabled;
    if (current.collectionPaused !== collectionPaused)
      this.store.setStatus({ ...current, collectionPaused });
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.collectionEnabled) this.beginRun(false);
  }

  requestRefresh(): RefreshResponse {
    this.providerNotBefore = this.store.readProviderNotBefore();
    if (!this.collectionEnabled)
      return { status: "deferred", nextDueAt: this.status().nextDueAt };
    if (
      this.providerNotBefore &&
      Date.parse(this.providerNotBefore) > this.now()
    )
      return { status: "deferred", nextDueAt: this.providerNotBefore };
    const status = this.status();
    if (
      !this.started ||
      this.stopped ||
      this.quarantined ||
      this.pausedRevision !== undefined ||
      (status.nextDueAt !== null && Date.parse(status.nextDueAt) > this.now())
    ) {
      return { status: "deferred", nextDueAt: status.nextDueAt };
    }
    if (this.active)
      return { status: "coalesced", nextDueAt: status.nextDueAt };
    this.beginRun(true);
    return { status: "accepted", nextDueAt: this.status().nextDueAt };
  }

  status(): SourceStatus {
    return {
      ...(this.store.getStatus() ?? baseStatus(this.cadenceSeconds)),
      providerNotBefore: this.store.readProviderNotBefore(),
    };
  }

  async runDue(): Promise<void> {
    if (this.stopped || !this.collectionEnabled) return;
    this.providerNotBefore = this.store.readProviderNotBefore();
    if (this.quarantined) return;
    if (this.active) {
      await this.active;
      return;
    }
    if (!this.started) this.started = true;
    this.beginRun(false);
    await this.active;
  }

  async waitForIdle(): Promise<void> {
    await this.active;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abortController?.abort();
    if (!this.closePromise) {
      this.closePromise = this.connector.close().catch(() => {});
    }
    await timedOut(
      Promise.all(
        [this.active, this.closePromise].filter(Boolean) as Promise<unknown>[],
      ).then(() => undefined),
      STOP_WAIT_MS,
    );
  }

  private beginRun(force: boolean): void {
    if (this.stopped || this.active) return;
    const run = this.executeRun(force).catch(() => {
      this.emit("refresh.internal-error", {
        diagnostic: {
          stage: "collection",
          kind: "browser-error",
          endpoint: null,
        },
      });
      try {
        this.store.setStatus({
          ...this.status(),
          health: "error",
          isRefreshing: false,
          message:
            "An internal collection error occurred; inspect diagnostics.",
          nextDueAt: instant(this.now() + this.cadenceSeconds * 1000),
        });
      } catch {}
    });
    this.active = run;
    void run.finally(() => {
      if (this.active === run) this.active = undefined;
      this.abortController = undefined;
      if (!this.stopped) this.scheduleNext();
    });
  }

  private async executeRun(force: boolean): Promise<void> {
    if (!this.collectionEnabled) return;
    const now = this.now();
    this.providerNotBefore = this.store.readProviderNotBefore();
    let sessionRevision: string | null;
    try {
      sessionRevision = await this.getSessionRevision();
      if (typeof sessionRevision !== "string" || !sessionRevision) {
        sessionRevision = null;
      }
    } catch {
      sessionRevision = null;
    }

    if (this.stopped) return;
    const revisionChanged =
      this.sessionRevision !== undefined &&
      sessionRevision !== this.sessionRevision;
    if (revisionChanged)
      this.emit("session.changed", {
        sessionPresent: sessionRevision !== null,
      });
    if (this.providerNotBefore && Date.parse(this.providerNotBefore) > now) {
      this.sessionRevision = sessionRevision;
      const previous = this.status();
      this.store.setStatus({
        ...previous,
        health: "rate-limited",
        isRefreshing: false,
        sessionPresent: sessionRevision !== null,
        nextDueAt: this.providerNotBefore,
        cadenceSeconds: this.cadenceSeconds,
        message:
          previous.health === "rate-limited"
            ? previous.message
            : "A previously observed provider rate limit remains active. Collection is waiting for its Retry-After deadline.",
      });
      return;
    }
    if (this.providerNotBefore) {
      this.providerNotBefore = null;
      this.store.clearExpiredProviderNotBefore(now);
      this.providerNotBefore = this.store.readProviderNotBefore();
    }
    if (
      this.pausedRevision !== undefined &&
      sessionRevision !== this.pausedRevision
    ) {
      this.pausedRevision = undefined;
      this.store.setPausedSessionRevision(undefined);
      this.failures = 0;
      if (sessionRevision !== null && this.status().health !== "rate-limited")
        this.store.setStatus({ ...this.status(), nextDueAt: instant(now) });
    }
    if (
      revisionChanged &&
      sessionRevision !== null &&
      this.status().health !== "rate-limited"
    ) {
      this.failures = 0;
      this.store.setStatus({ ...this.status(), nextDueAt: instant(now) });
    }
    this.sessionRevision = sessionRevision;

    if (this.pausedRevision !== undefined) {
      const previous = this.status();
      this.store.setStatus({
        ...previous,
        health:
          previous.health === "provider-blocked"
            ? "provider-blocked"
            : "needs-login",
        message:
          previous.health === "provider-blocked"
            ? "McCarren access is blocked; reconnect or wait for provider access to change."
            : "McCarren login is required. Reconnect with make connect.",
        sessionPresent: sessionRevision !== null,
        isRefreshing: false,
        nextDueAt: null,
      });
      return;
    }

    if (sessionRevision === null) {
      const previous = this.status();
      const connectedBefore = previous.lastAttemptAt !== null;
      this.store.setStatus({
        ...previous,
        health: connectedBefore ? "needs-login" : "never-connected",
        message: connectedBefore
          ? "McCarren login is required. Reconnect with make connect."
          : "No McCarren session is connected.",
        sessionPresent: false,
        isRefreshing: false,
        nextDueAt: instant(now + this.cadenceSeconds * 1000),
      });
      if (connectedBefore) {
        this.pausedRevision = null;
        this.store.setPausedSessionRevision(null);
      }
      return;
    }

    const existingStatus = this.status();
    if (
      !force &&
      existingStatus.nextDueAt !== null &&
      Date.parse(existingStatus.nextDueAt) > now
    ) {
      this.scheduleTimer(Date.parse(existingStatus.nextDueAt));
      return;
    }

    const attemptedAt = instant(now);
    this.store.prune(localToday(now), instant(now - 7 * 24 * 60 * 60 * 1000));
    this.abortController = new AbortController();
    const controller = this.abortController;
    const runRecord: RefreshRun = {
      id: randomUUID(),
      startedAt: attemptedAt,
      finishedAt: null,
      outcome: "running",
      requestedDates: 8,
      completedDates: 0,
      requests: 0,
      elapsedMs: 0,
      errorCode: null,
      message: null,
      diagnostic: null,
      trigger: force ? "manual" : "scheduled",
    };
    this.store.recordRun(runRecord);
    this.emit("refresh.started", { runId: runRecord.id, requestedDates: 8 });
    this.store.setStatus({
      ...existingStatus,
      health: "refreshing",
      message: "Refreshing McCarren schedule.",
      sessionPresent: true,
      isRefreshing: true,
      cadenceSeconds: this.cadenceSeconds,
      lastAttemptAt: attemptedAt,
      nextDueAt: null,
    });

    const dates = dateRange(localToday(now), 8);
    const requestedDates = new Set(dates);
    const completeDates = new Set<string>();
    const failedDates = new Set<string>();
    let latestFailure: FailureCode | undefined;
    let retryAfterSeconds: number | undefined;
    let summary: CollectionSummary | undefined;
    let diagnostic: ConnectorDiagnostic | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let acceptsResults = true;
    try {
      const operation = this.connector.collect({
        from: dates[0]!,
        days: dates.length,
        signal: controller.signal,
        onPartition: (input) => {
          if (!acceptsResults || this.stopped || controller.signal.aborted)
            return;
          const partition = PartitionResultSchema.parse(input);
          if (!requestedDates.has(partition.localDate)) {
            latestFailure = "incomplete";
            return;
          }
          if (
            partition.state === "failed" &&
            partition.errorCode === "rate-limited"
          ) {
            this.store.setProviderNotBefore(
              instant(
                this.now() + (partition.retryAfterSeconds ?? 3600) * 1000,
              ),
            );
            this.providerNotBefore = this.store.readProviderNotBefore();
          }
          this.store.publish(partition);
          if (partition.state === "complete") {
            completeDates.add(partition.localDate);
          } else {
            failedDates.add(partition.localDate);
            latestFailure = partition.errorCode;
            const parsed = ConnectorDiagnosticSchema.safeParse(
              partition.diagnostic,
            );
            if (parsed.success) diagnostic = parsed.data;
            this.emit("partition.failed", {
              runId: runRecord.id,
              localDate: partition.localDate,
              errorCode: partition.errorCode,
              ...(diagnostic ? { diagnostic } : {}),
            });
            retryAfterSeconds = Math.max(
              retryAfterSeconds ?? 0,
              partition.retryAfterSeconds ?? 0,
            );
          }
        },
      });
      summary = await Promise.race([
        operation,
        new Promise<CollectionSummary>((resolve) => {
          deadline = setTimeout(() => {
            acceptsResults = false;
            this.quarantined = true;
            controller.abort();
            void this.connector.close().catch(() => {});
            resolve({
              attemptedDates: completeDates.size + failedDates.size,
              completedDates: completeDates.size,
              elapsedMs: this.collectionTimeoutMs,
              requests: 0,
              terminalError: "unavailable",
              message:
                "Collection exceeded its deadline; cached observations are retained.",
              diagnostic: {
                stage: "collection",
                kind: "timeout",
                endpoint: null,
              },
            });
          }, this.collectionTimeoutMs);
        }),
      ]);
    } catch (error) {
      latestFailure = safeSummaryError(error);
    } finally {
      clearTimeout(deadline);
      acceptsResults = false;
    }
    if (this.stopped) {
      this.store.recordRun({
        ...runRecord,
        finishedAt: instant(this.now()),
        outcome: "interrupted",
        completedDates: completeDates.size,
        requests: summary?.requests ?? 0,
        elapsedMs: Math.max(0, this.now() - now),
        errorCode: "unavailable",
        message: "Collection stopped during service shutdown.",
        diagnostic: { stage: "collection", kind: "cancelled", endpoint: null },
      });
      return;
    }
    diagnostic = summary?.diagnostic ?? diagnostic;

    const terminalError = summary?.terminalError ?? latestFailure;
    const allComplete =
      completeDates.size === dates.length &&
      failedDates.size === 0 &&
      terminalError === undefined;
    const completedAt = instant(this.now());
    const old = this.status();
    for (const date of dates) {
      if (completeDates.has(date) || failedDates.has(date)) continue;
      this.store.publish({
        state: "failed",
        localDate: date,
        checkedAt: completedAt,
        errorCode: terminalError ?? "incomplete",
        message:
          "Collection did not verify this date; cached observations are retained.",
        ...(diagnostic ? { diagnostic } : {}),
      });
    }
    const finishRun = (
      outcome: RefreshRun["outcome"],
      errorCode: FailureCode | null,
      message: string | null,
      nextDueAt: string | null,
    ) => {
      const run = {
        ...runRecord,
        finishedAt: completedAt,
        outcome,
        completedDates: completeDates.size,
        requests:
          diagnostic?.kind === "timeout" && diagnostic.stage === "collection"
            ? null
            : (summary?.requests ?? 0),
        elapsedMs: Math.max(0, this.now() - now),
        errorCode,
        message,
        diagnostic: diagnostic ?? null,
      };
      this.store.recordRun(run);
      this.emit("refresh.finished", {
        runId: run.id,
        outcome,
        completedDates: run.completedDates,
        requestedDates: 8,
        requests: run.requests,
        elapsedMs: run.elapsedMs,
        errorCode,
        diagnostic: run.diagnostic,
        nextDueAt,
      });
    };
    if (allComplete) {
      this.failures = 0;
      this.store.setStatus({
        ...old,
        health: "healthy",
        message: "McCarren schedule is current.",
        sessionPresent: true,
        isRefreshing: false,
        cadenceSeconds: this.cadenceSeconds,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: completedAt,
        nextDueAt: instant(this.now() + this.cadenceSeconds * 1000),
        lastDiagnostic: null,
      });
      finishRun("healthy", null, null, this.status().nextDueAt);
      return;
    }

    const failure = terminalError ?? "incomplete";
    const pause = failure === "needs-login" || failure === "provider-blocked";
    const rateLimited = failure === "rate-limited";
    const health: SourceStatus["health"] = pause
      ? failure
      : rateLimited
        ? "rate-limited"
        : completeDates.size > 0
          ? "partial"
          : "error";
    this.failures++;
    const delay = pause
      ? this.cadenceSeconds
      : backoffSeconds(
          failure,
          this.failures,
          this.cadenceSeconds,
          summary?.retryAfterSeconds ?? retryAfterSeconds,
        );
    if (rateLimited) {
      this.providerNotBefore = instant(this.now() + delay * 1000);
      this.store.setProviderNotBefore(this.providerNotBefore);
      this.providerNotBefore = this.store.readProviderNotBefore();
    }
    this.store.setStatus({
      ...old,
      health,
      message:
        health === "needs-login"
          ? "McCarren login is required. Reconnect with make connect."
          : health === "provider-blocked"
            ? "McCarren access is blocked; collection is paused."
            : health === "rate-limited"
              ? "McCarren rate-limited this read; retry is delayed."
              : health === "partial"
                ? "Some McCarren dates could not be refreshed; cached openings are retained."
                : this.quarantined
                  ? "Collection timed out and is paused. Restart the local service to recover; cached openings are retained."
                  : "McCarren schedule refresh failed; cached openings are retained.",
      sessionPresent: true,
      isRefreshing: false,
      cadenceSeconds: this.cadenceSeconds,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: old.lastSuccessAt,
      nextDueAt:
        this.providerNotBefore &&
        Date.parse(this.providerNotBefore) > this.now()
          ? this.providerNotBefore
          : pause || this.quarantined
            ? null
            : instant(this.now() + delay * 1000),
      lastDiagnostic: diagnostic ?? null,
    });
    finishRun(
      completeDates.size ? "partial" : "failed",
      failure,
      this.status().message,
      this.status().nextDueAt,
    );
    if (pause) {
      this.pausedRevision = this.sessionRevision;
      this.store.setPausedSessionRevision(this.sessionRevision);
    }
  }

  private scheduleNext(): void {
    if (this.stopped || !this.started || !this.collectionEnabled) return;
    const dueAt = this.status().nextDueAt;
    if (dueAt === null) {
      this.scheduleTimer(this.now() + SESSION_CHECK_SECONDS * 1000);
    } else {
      this.scheduleTimer(
        Math.min(Date.parse(dueAt), this.now() + SESSION_CHECK_SECONDS * 1000),
      );
    }
  }

  private emit(event: string, details: Record<string, unknown>): void {
    try {
      this.onEvent({
        at: instant(this.now()),
        event,
        sourceId: "mccarren",
        ...details,
      });
    } catch {}
  }

  private scheduleTimer(dueAt: number): void {
    if (this.stopped || !this.started) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Math.min(2_147_000_000, dueAt - this.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runDue();
    }, delay);
  }
}
