import {
  DiagnosticsResponseSchema,
  type DiagnosticsResponse,
  type SourceStatus,
} from "../../../packages/contracts/src/index.ts";
import type { ScheduleStore } from "./store.ts";

export function diagnostics(
  store: ScheduleStore,
  source: SourceStatus,
  now: number,
  limit = 20,
): DiagnosticsResponse {
  const age =
    source.lastSuccessAt === null
      ? null
      : Math.max(
          0,
          Math.floor((now - Date.parse(source.lastSuccessAt)) / 1000),
        );
  const threshold = Math.max(source.cadenceSeconds * 2, 120);
  const healthy = source.health === "healthy" || source.health === "refreshing";
  const isFresh = age !== null && age <= threshold && healthy;
  const status = source.collectionPaused
    ? "paused"
    : source.health === "never-connected"
      ? "never-connected"
      : !healthy
        ? "degraded"
        : age === null || age > threshold
          ? "stale"
          : source.isRefreshing
            ? "refreshing"
            : "ok";
  return DiagnosticsResponseSchema.parse({
    source,
    collection: {
      status,
      isFresh,
      lastSuccessAgeSeconds: age,
      staleAfterSeconds: threshold,
    },
    runs: store.readRuns(limit),
    checks: store.readChecks(Math.min(100, limit * 4)),
  });
}
