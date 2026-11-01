import {
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  chmodSync,
  constants,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  InstantSchema,
  SourceStatusSchema,
  ConnectorDiagnosticSchema,
  BOOKING_URL,
  TIME_ZONE,
  type ConnectorDiagnostic,
} from "../../../packages/contracts/src/index.ts";
import { resolveProjectRoot } from "./local-state.ts";
import { ScheduleStore } from "./store.ts";

function disabledWithoutExplicitEnable(): {
  allowed: false;
  message: string;
} {
  return {
    allowed: false,
    message:
      "Provider commands are disabled by default without local collection status. Set COLLECTION_ENABLED=true only after confirming an acceptable provider cadence. No provider request was made.",
  };
}

/** Read only local metadata. Operator probes must also honor a known 429 deadline. */
export function providerReadPermission(
  databasePath = join(
    resolveProjectRoot(import.meta.url),
    ".local",
    "schedule.sqlite",
  ),
  now = Date.now(),
): { allowed: true } | { allowed: false; message: string } {
  const enabledSetting = process.env.COLLECTION_ENABLED;
  if (enabledSetting === "false")
    return {
      allowed: false,
      message:
        "Provider commands are disabled by COLLECTION_ENABLED=false. No provider request was made.",
    };
  if (enabledSetting !== undefined && enabledSetting !== "true")
    return {
      allowed: false,
      message:
        "COLLECTION_ENABLED must be true or false. No provider request was made.",
    };
  try {
    const file = lstatSync(databasePath);
    const parent = lstatSync(dirname(databasePath));
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      !parent.isDirectory() ||
      parent.isSymbolicLink()
    )
      return {
        allowed: false,
        message: "Unsafe local state; inspect service diagnostics first.",
      };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return enabledSetting === "true"
        ? { allowed: true }
        : disabledWithoutExplicitEnable();
    return {
      allowed: false,
      message: "Local collection status could not be read.",
    };
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const cooldown = database
      .prepare("SELECT value FROM metadata WHERE key = 'provider-not-before'")
      .get();
    if (cooldown) {
      const deadline = InstantSchema.parse(cooldown.value);
      if (Date.parse(deadline) > now)
        return {
          allowed: false,
          message: `CourtReserve cooldown is active until ${deadline}. No provider request was made; use local diagnostics.`,
        };
    }
    const row = database
      .prepare("SELECT value_json FROM source_status WHERE id = 1")
      .get();
    if (!row)
      return enabledSetting === "true"
        ? { allowed: true }
        : disabledWithoutExplicitEnable();
    const rawSource: unknown = JSON.parse(String(row.value_json));
    if (
      (typeof rawSource !== "object" ||
        rawSource === null ||
        !Object.hasOwn(rawSource, "collectionPaused")) &&
      enabledSetting !== "true"
    )
      return disabledWithoutExplicitEnable();
    const source = SourceStatusSchema.parse(rawSource);
    if (source.collectionPaused)
      return {
        allowed: false,
        message:
          "McCarren collection is paused locally. No provider request was made; resume only after an approved cadence is set.",
      };
    if (
      source.health === "rate-limited" &&
      source.nextDueAt &&
      Date.parse(source.nextDueAt) > now
    )
      return {
        allowed: false,
        message: `CourtReserve cooldown is active until ${source.nextDueAt}. No provider request was made; use make status or the dashboard diagnostics.`,
      };
    if (source.isRefreshing)
      return {
        allowed: false,
        message:
          "A collection is already active. Use cached diagnostics instead of a concurrent provider probe.",
      };
    return { allowed: true };
  } catch {
    return {
      allowed: false,
      message:
        "Collection status is invalid; inspect local diagnostics before making provider requests.",
    };
  } finally {
    database?.close();
  }
}

/** Persist a newly observed operator 429 before any cleanup or subsequent probe. */
export function persistObservedRateLimit(
  observation: {
    observedAt: string;
    retryAfterSeconds?: number;
    diagnostic?: ConnectorDiagnostic;
    requests?: number | null;
  },
  databasePath = join(
    resolveProjectRoot(import.meta.url),
    ".local",
    "schedule.sqlite",
  ),
): string {
  const observedAt = InstantSchema.parse(observation.observedAt);
  const retry = observation.retryAfterSeconds ?? 3600;
  if (!Number.isInteger(retry) || retry < 1 || retry > 86400)
    throw new Error("Invalid provider Retry-After");
  try {
    mkdirSync(dirname(databasePath), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new Error("Unable to create local collection storage");
  }
  const parent = lstatSync(dirname(databasePath));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o777) !== 0o700
  )
    throw new Error("Unsafe local collection storage");
  try {
    const fd = openSync(
      databasePath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new Error("Unable to open local collection storage");
  }
  const file = lstatSync(databasePath);
  if (!file.isFile() || file.isSymbolicLink())
    throw new Error("Unsafe local collection storage");
  chmodSync(databasePath, 0o600);
  const diagnostic = ConnectorDiagnosticSchema.parse({
    stage: "schedule",
    kind: "http-error",
    endpoint: "schedule-data",
    ...observation.diagnostic,
    httpStatus: 429,
  });
  const store = new ScheduleStore(databasePath);
  try {
    const previous = store.getStatus();
    const requested = Math.max(
      Date.parse(observedAt) + retry * 1000,
      Date.parse(previous?.nextDueAt ?? observedAt),
    );
    store.setProviderNotBefore(new Date(requested).toISOString());
    const deadline = store.readProviderNotBefore()!;
    const message =
      "An operator read confirmed HTTP 429. Collection is waiting for the provider cooldown; reconnecting cannot clear an IP rate limit.";
    store.recordRun({
      id: randomUUID(),
      startedAt: observedAt,
      finishedAt: observedAt,
      outcome: "failed",
      requestedDates: 1,
      completedDates: 0,
      requests: observation.requests ?? null,
      elapsedMs: 0,
      errorCode: "rate-limited",
      message,
      diagnostic,
      trigger: "diagnostic",
    });
    store.setStatus({
      id: "mccarren",
      name: "McCarren Tennis Center",
      timeZone: TIME_ZONE,
      bookingUrl: BOOKING_URL,
      transport: "browser-dom",
      sessionPresent: false,
      cadenceSeconds: 900,
      lastAttemptAt: null,
      lastSuccessAt: null,
      ...previous,
      health: "rate-limited",
      isRefreshing: false,
      collectionPaused: previous?.collectionPaused ?? false,
      providerNotBefore: deadline,
      message,
      nextDueAt: deadline,
      lastDiagnostic: diagnostic,
    });
    return deadline;
  } finally {
    store.close();
  }
}
