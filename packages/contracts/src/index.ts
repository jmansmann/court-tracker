import { DateTime } from "luxon";
import { z } from "zod";

export const TIME_ZONE = "America/New_York";
export const SOURCE_ID = "mccarren";
export const BOOKING_URL =
  "https://app.courtreserve.com/Online/Reservations/Index/10243";
export const LocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = DateTime.fromISO(value, { zone: TIME_ZONE });
    return date.isValid && date.toISODate() === value;
  });
export const InstantSchema = z.iso.datetime({ offset: true });
export const FailureCodeSchema = z.enum([
  "needs-login",
  "provider-blocked",
  "rate-limited",
  "incomplete",
  "parse-error",
  "unavailable",
]);
export type FailureCode = z.infer<typeof FailureCodeSchema>;

export const ConnectorDiagnosticSchema = z
  .object({
    stage: z.enum([
      "session",
      "navigation",
      "configuration",
      "schedule",
      "date-navigation",
      "grid",
      "collection",
    ]),
    kind: z.enum([
      "http-error",
      "network-error",
      "timeout",
      "invalid-payload",
      "render-incomplete",
      "cancelled",
      "browser-error",
      "authentication",
    ]),
    endpoint: z
      .enum(["portal-navigation", "schedule-configuration", "schedule-data"])
      .nullable(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    networkCode: z
      .string()
      .regex(/^net::ERR_[A-Z0-9_]+$/)
      .max(80)
      .optional(),
  })
  .strict();
export type ConnectorDiagnostic = z.infer<typeof ConnectorDiagnosticSchema>;

export const OpeningSchema = z.object({
  id: z.string().max(160),
  sourceId: z.literal("mccarren"),
  courtId: z.number().int().positive(),
  courtLabel: z.string().min(1).max(100),
  localDate: LocalDateSchema,
  localTime: z.string().regex(/^\d{2}:\d{2}$/),
  startUtc: InstantSchema,
  endUtc: InstantSchema.nullable(),
  kind: z.literal("reserve-start"),
  providerLabel: z.literal("Reserve"),
  durationMinutes: z.number().int().positive().nullable(),
  price: z
    .object({
      amount: z.number().nonnegative(),
      currency: z.string().length(3),
      basis: z.string().max(80),
    })
    .nullable(),
  eligibility: z.enum(["unknown", "eligible", "blocked"]),
  bookingUrl: z.literal(BOOKING_URL),
  observedAt: InstantSchema,
});
export type Opening = z.infer<typeof OpeningSchema>;

export const CompletePartitionSchema = z.object({
  state: z.literal("complete"),
  localDate: LocalDateSchema,
  checkedAt: InstantSchema,
  coverageStartUtc: InstantSchema,
  coverageEndUtc: InstantSchema,
  openings: z.array(OpeningSchema).max(10000),
  note: z.string().max(500).nullable(),
});
export const FailedPartitionSchema = z.object({
  state: z.literal("failed"),
  localDate: LocalDateSchema,
  checkedAt: InstantSchema,
  errorCode: FailureCodeSchema,
  message: z.string().max(500),
  retryAfterSeconds: z.number().positive().max(86400).optional(),
  diagnostic: ConnectorDiagnosticSchema.optional(),
});
export const PartitionResultSchema = z.discriminatedUnion("state", [
  CompletePartitionSchema,
  FailedPartitionSchema,
]);
export type CompletePartition = z.infer<typeof CompletePartitionSchema>;
export type PartitionResult = z.infer<typeof PartitionResultSchema>;
export type FailedPartition = z.infer<typeof FailedPartitionSchema>;

export interface CollectionOptions {
  from: string;
  days: number;
  onPartition: (result: PartitionResult) => void | Promise<void>;
  signal?: AbortSignal;
}
export interface CollectionSummary {
  attemptedDates: number;
  completedDates: number;
  elapsedMs: number;
  requests: number;
  terminalError?: FailureCode;
  message?: string;
  retryAfterSeconds?: number;
  diagnostic?: ConnectorDiagnostic;
}
export interface ScheduleConnector {
  collect(options: CollectionOptions): Promise<CollectionSummary>;
  close(): Promise<void>;
}

export const PreferencesSchema = z.object({
  view: z.enum(["week", "day"]).default("week"),
  durationMinutes: z
    .union([z.literal(30), z.literal(60), z.literal(90), z.literal(120)])
    .nullable()
    .default(null),
  includeUnknownDuration: z.boolean().default(true),
  courtIds: z.array(z.number().int().positive()).max(50).default([]),
});
export type Preferences = z.infer<typeof PreferencesSchema>;
export const PreferencesPatchSchema = PreferencesSchema.partial().strict();

export const SourceStatusSchema = z.object({
  id: z.literal("mccarren"),
  name: z.literal("McCarren Tennis Center"),
  timeZone: z.literal(TIME_ZONE),
  bookingUrl: z.literal(BOOKING_URL),
  transport: z.literal("browser-dom"),
  health: z.enum([
    "never-connected",
    "healthy",
    "refreshing",
    "needs-login",
    "provider-blocked",
    "rate-limited",
    "error",
    "partial",
  ]),
  message: z.string().max(500),
  sessionPresent: z.boolean(),
  isRefreshing: z.boolean(),
  collectionPaused: z.boolean().default(false),
  cadenceSeconds: z.number().int().positive(),
  lastAttemptAt: InstantSchema.nullable(),
  lastSuccessAt: InstantSchema.nullable(),
  nextDueAt: InstantSchema.nullable(),
  providerNotBefore: InstantSchema.nullable().optional(),
  lastDiagnostic: ConnectorDiagnosticSchema.nullable().optional(),
});
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
export const PartitionViewSchema = z.object({
  localDate: LocalDateSchema,
  coverage: z.enum(["complete", "unknown"]),
  coverageStartUtc: InstantSchema.nullable(),
  coverageEndUtc: InstantSchema.nullable(),
  lastAttemptAt: InstantSchema.nullable(),
  lastSuccessAt: InstantSchema.nullable(),
  isStale: z.boolean(),
  errorCode: FailureCodeSchema.nullable(),
  message: z.string().max(500).nullable(),
  openings: z.array(OpeningSchema),
});
export type PartitionView = z.infer<typeof PartitionViewSchema>;
export const ScheduleResponseSchema = z.object({
  revision: z.string(),
  range: z.object({
    from: LocalDateSchema,
    to: LocalDateSchema,
    timeZone: z.literal(TIME_ZONE),
  }),
  source: SourceStatusSchema,
  partitions: z.array(PartitionViewSchema).max(7),
  preferences: PreferencesSchema,
});
export type ScheduleResponse = z.infer<typeof ScheduleResponseSchema>;
export const RefreshResponseSchema = z.object({
  status: z.enum(["accepted", "coalesced", "deferred"]),
  nextDueAt: InstantSchema.nullable(),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

export const RefreshRunSchema = z
  .object({
    id: z.string().min(1).max(100),
    startedAt: InstantSchema,
    finishedAt: InstantSchema.nullable(),
    outcome: z.enum(["running", "healthy", "partial", "failed", "interrupted"]),
    requestedDates: z.number().int().min(1).max(8),
    completedDates: z.number().int().min(0).max(8),
    requests: z.number().int().nonnegative().nullable(),
    elapsedMs: z.number().int().nonnegative(),
    errorCode: FailureCodeSchema.nullable(),
    message: z.string().max(500).nullable(),
    diagnostic: ConnectorDiagnosticSchema.nullable(),
    trigger: z.enum(["scheduled", "manual", "diagnostic"]).optional(),
  })
  .strict();
export type RefreshRun = z.infer<typeof RefreshRunSchema>;
export const CheckSummarySchema = z.object({
  localDate: LocalDateSchema,
  checkedAt: InstantSchema,
  state: z.enum(["complete", "failed"]),
  errorCode: FailureCodeSchema.nullable(),
  message: z.string().max(500).nullable(),
});
export type CheckSummary = z.infer<typeof CheckSummarySchema>;
export const DiagnosticsResponseSchema = z.object({
  source: SourceStatusSchema,
  collection: z.object({
    status: z.enum([
      "ok",
      "stale",
      "degraded",
      "never-connected",
      "refreshing",
      "paused",
    ]),
    isFresh: z.boolean(),
    lastSuccessAgeSeconds: z.number().int().nonnegative().nullable(),
    staleAfterSeconds: z.number().int().positive(),
  }),
  runs: z.array(RefreshRunSchema).max(100),
  checks: z.array(CheckSummarySchema).max(100),
});
export type DiagnosticsResponse = z.infer<typeof DiagnosticsResponseSchema>;

export function localToday(now = Date.now()): string {
  return DateTime.fromMillis(now, { zone: TIME_ZONE }).toISODate()!;
}
export function dateRange(from: string, days: number): string[] {
  LocalDateSchema.parse(from);
  if (!Number.isInteger(days) || days < 1 || days > 8)
    throw new Error("Invalid date range");
  const start = DateTime.fromISO(from, { zone: TIME_ZONE });
  return Array.from(
    { length: days },
    (_, index) => start.plus({ days: index }).toISODate()!,
  );
}
