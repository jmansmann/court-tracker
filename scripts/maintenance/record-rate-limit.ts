import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ScheduleStore } from "../../apps/service/src/store.ts";
import {
  InstantSchema,
  type ConnectorDiagnostic,
} from "../../packages/contracts/src/index.ts";
import { resolveProjectRoot } from "../../apps/service/src/local-state.ts";

// Manual incident-state recording, not a general runtime command. This imports
// a known one-off HTTP 429 without contacting the provider or changing schedules.
// Run with the service stopped.
const observedAt = InstantSchema.parse(process.argv[2]);
const retryAfterSeconds = Number(process.argv[3] ?? "3600");
if (
  !Number.isInteger(retryAfterSeconds) ||
  retryAfterSeconds < 1 ||
  retryAfterSeconds > 86400
)
  throw new Error("Retry-After must be between 1 and 86400 seconds");
const local = join(resolveProjectRoot(import.meta.url), ".local");
const file = join(local, "schedule.sqlite");
const directory = await lstat(local);
const database = await lstat(file);
if (
  !directory.isDirectory() ||
  directory.isSymbolicLink() ||
  !database.isFile() ||
  database.isSymbolicLink() ||
  (directory.mode & 0o777) !== 0o700 ||
  (database.mode & 0o777) !== 0o600
)
  throw new Error("Unsafe local diagnostics storage");
const store = new ScheduleStore(file);
try {
  const previous = store.getStatus();
  if (!previous) throw new Error("Existing source status is required");
  const diagnostic: ConnectorDiagnostic = {
    stage: "schedule",
    kind: "http-error",
    endpoint: "schedule-data",
    httpStatus: 429,
    networkCode: "net::ERR_FAILED",
  };
  let notBefore = Math.max(
    Date.parse(observedAt) + retryAfterSeconds * 1000,
    Date.parse(previous.nextDueAt ?? observedAt),
  );
  const message =
    "A one-off diagnosis confirmed Cloudflare HTTP 429 on the home network. Collection is waiting for the provider's Retry-After deadline; reconnecting does not clear an IP rate limit.";
  store.recordRun({
    id: randomUUID(),
    startedAt: observedAt,
    finishedAt: observedAt,
    outcome: "failed",
    requestedDates: 1,
    completedDates: 0,
    requests: 4,
    elapsedMs: 0,
    errorCode: "rate-limited",
    message,
    diagnostic,
    trigger: "diagnostic",
  });
  store.setProviderNotBefore(new Date(notBefore).toISOString());
  notBefore = Date.parse(store.readProviderNotBefore()!);
  store.setStatus({
    ...previous,
    health: "rate-limited",
    isRefreshing: false,
    cadenceSeconds: 900,
    nextDueAt: new Date(notBefore).toISOString(),
    lastDiagnostic: diagnostic,
    message,
  });
  console.log(
    JSON.stringify({
      event: "diagnostic.recorded",
      observedAt,
      httpStatus: 429,
      providerNotBefore: new Date(notBefore).toISOString(),
    }),
  );
} finally {
  store.close();
}
