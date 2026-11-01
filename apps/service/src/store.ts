import { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import {
  CompletePartitionSchema,
  CheckSummarySchema,
  FailureCodeSchema,
  InstantSchema,
  LocalDateSchema,
  OpeningSchema,
  PartitionResultSchema,
  PreferencesPatchSchema,
  PreferencesSchema,
  RefreshRunSchema,
  SourceStatusSchema,
  TIME_ZONE,
  type CheckSummary,
  type Opening,
  type PartitionResult,
  type PartitionView,
  type Preferences,
  type RefreshRun,
  type SourceStatus,
} from "../../../packages/contracts/src/index.ts";

interface PartitionRow {
  local_date: string;
  coverage_start_utc: string;
  coverage_end_utc: string;
  openings_json: string;
  last_success_at: string | null;
}

interface CheckRow {
  local_date: string;
  checked_at: string;
  state: string;
  error_code: string | null;
  message: string | null;
}

interface RunRow {
  id: string;
  started_at_ms: number;
  record_json: string;
}

const INITIAL_PREFERENCES = PreferencesSchema.parse({});
const STALE_MINIMUM_SECONDS = 120;

function safeText(value: string): string {
  return value
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "[redacted]")
    .replace(
      /\b(?:authorization|cookie|token|password|secret|session)\b\s*[:=]?\s*[^\s,;]*/gi,
      "[redacted]",
    )
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .slice(0, 500);
}

function validateOpeningDate(opening: Opening, localDate: string): void {
  const start = DateTime.fromISO(opening.startUtc, { setZone: true });
  const local = start.setZone(TIME_ZONE);
  if (
    opening.localDate !== localDate ||
    local.toISODate() !== localDate ||
    local.toFormat("HH:mm") !== opening.localTime
  ) {
    throw new Error("Invalid partition result");
  }
}

function parseOpenings(value: string): Opening[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("Stored schedule data is invalid");
  }
  const parsed = OpeningSchema.array().safeParse(decoded);
  if (!parsed.success) throw new Error("Stored schedule data is invalid");
  return parsed.data;
}

function checkMessage(row: CheckRow): string | null {
  if (row.state === "complete") return null;
  return safeText(row.message ?? "Schedule check failed.");
}

/** Durable, source-scoped schedule snapshots and redacted operational metadata. */
export class ScheduleStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    try {
      this.database = new DatabaseSync(databasePath);
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.database.exec("PRAGMA journal_mode = WAL");
      this.migrate();
    } catch {
      throw new Error("Unable to open schedule storage");
    }
  }

  publish(result: PartitionResult): void {
    this.assertOpen();
    const parsed = PartitionResultSchema.safeParse(result);
    if (!parsed.success) throw new Error("Invalid partition result");
    const partition = parsed.data;
    const checkedAtMs = Date.parse(partition.checkedAt);
    if (!Number.isFinite(checkedAtMs))
      throw new Error("Invalid partition result");

    if (partition.state === "complete") {
      const complete = CompletePartitionSchema.safeParse(partition);
      if (!complete.success) throw new Error("Invalid partition result");
      const startMs = Date.parse(complete.data.coverageStartUtc);
      const endMs = Date.parse(complete.data.coverageEndUtc);
      if (endMs <= startMs) throw new Error("Invalid partition result");
      const openingIds = new Set<string>();
      const courtStarts = new Set<string>();
      for (const opening of complete.data.openings) {
        validateOpeningDate(opening, complete.data.localDate);
        const openingMs = Date.parse(opening.startUtc);
        const courtStart = `${opening.courtId}:${opening.startUtc}`;
        if (
          openingMs < startMs ||
          openingMs >= endMs ||
          openingIds.has(opening.id) ||
          courtStarts.has(courtStart)
        ) {
          throw new Error("Invalid partition result");
        }
        openingIds.add(opening.id);
        courtStarts.add(courtStart);
      }
    }

    this.transaction(() => {
      if (partition.state === "complete") {
        this.database
          .prepare(
            `INSERT INTO partitions(local_date, coverage_start_utc, coverage_end_utc, openings_json, last_success_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(local_date) DO UPDATE SET
               coverage_start_utc = excluded.coverage_start_utc,
               coverage_end_utc = excluded.coverage_end_utc,
               openings_json = excluded.openings_json,
               last_success_at = excluded.last_success_at`,
          )
          .run(
            partition.localDate,
            partition.coverageStartUtc,
            partition.coverageEndUtc,
            JSON.stringify(partition.openings),
            partition.checkedAt,
          );
        this.database
          .prepare(
            `INSERT INTO partition_checks(local_date, checked_at, checked_at_ms, state, error_code, message)
             VALUES (?, ?, ?, 'complete', NULL, NULL)`,
          )
          .run(partition.localDate, partition.checkedAt, checkedAtMs);
      } else {
        const code = FailureCodeSchema.parse(partition.errorCode);
        this.database
          .prepare(
            `INSERT INTO partition_checks(local_date, checked_at, checked_at_ms, state, error_code, message)
             VALUES (?, ?, ?, 'failed', ?, ?)`,
          )
          .run(
            partition.localDate,
            partition.checkedAt,
            checkedAtMs,
            code,
            safeText(partition.message),
          );
      }
      this.bumpRevision();
    });
  }

  recordRun(run: RefreshRun): void {
    this.assertOpen();
    const parsed = RefreshRunSchema.safeParse(run);
    if (!parsed.success) throw new Error("Invalid refresh run");
    const normalized: RefreshRun = {
      ...parsed.data,
      message:
        parsed.data.message === null ? null : safeText(parsed.data.message),
    };
    const startedAtMs = Date.parse(normalized.startedAt);
    const finishedAtMs = normalized.finishedAt
      ? Date.parse(normalized.finishedAt)
      : null;
    if (
      !Number.isFinite(startedAtMs) ||
      (finishedAtMs !== null &&
        (!Number.isFinite(finishedAtMs) || finishedAtMs < startedAtMs)) ||
      normalized.completedDates > normalized.requestedDates ||
      (normalized.outcome === "running" && normalized.finishedAt !== null) ||
      (normalized.outcome !== "running" && normalized.finishedAt === null)
    ) {
      throw new Error("Invalid refresh run");
    }

    const recordJson = JSON.stringify(normalized);
    this.transaction(() => {
      const previous = this.database
        .prepare("SELECT record_json FROM refresh_runs WHERE id = ?")
        .get(normalized.id) as { record_json: string } | undefined;
      if (previous) {
        let previousRun: RefreshRun;
        try {
          previousRun = RefreshRunSchema.parse(
            JSON.parse(previous.record_json),
          );
        } catch {
          throw new Error("Stored refresh history is invalid");
        }
        // Run ids describe one lifecycle: once terminal, a record cannot be reopened.
        if (previousRun.outcome !== "running") return;
        if (previous.record_json === recordJson) return;
      }
      this.database
        .prepare(
          `INSERT INTO refresh_runs(id, started_at_ms, record_json)
           VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             started_at_ms = excluded.started_at_ms,
             record_json = excluded.record_json`,
        )
        .run(normalized.id, startedAtMs, recordJson);
      this.bumpRevision();
    });
  }

  readRuns(limit = 20): RefreshRun[] {
    this.assertOpen();
    this.validateHistoryLimit(limit, 100);
    const rows = this.database
      .prepare(
        "SELECT id, started_at_ms, record_json FROM refresh_runs ORDER BY started_at_ms DESC, rowid DESC LIMIT ?",
      )
      .all(limit) as unknown as RunRow[];
    return rows.map((row) => {
      try {
        return RefreshRunSchema.parse(JSON.parse(row.record_json));
      } catch {
        throw new Error("Stored refresh history is invalid");
      }
    });
  }

  readChecks(limit = 50): CheckSummary[] {
    this.assertOpen();
    this.validateHistoryLimit(limit, 100);
    const rows = this.database
      .prepare(
        "SELECT local_date, checked_at, state, error_code, message FROM partition_checks ORDER BY checked_at_ms DESC, id DESC LIMIT ?",
      )
      .all(limit) as unknown as CheckRow[];
    return rows.map((row) => {
      const summary = {
        localDate: row.local_date,
        checkedAt: row.checked_at,
        state: row.state,
        errorCode:
          row.error_code === null
            ? null
            : FailureCodeSchema.parse(row.error_code),
        message:
          row.state === "complete"
            ? null
            : safeText(row.message ?? "Schedule check failed."),
      };
      const parsed = CheckSummarySchema.safeParse(summary);
      if (!parsed.success) throw new Error("Stored check history is invalid");
      return parsed.data;
    });
  }

  interruptRuns(finishedAt: string): number {
    this.assertOpen();
    const parsedFinishedAt = InstantSchema.safeParse(finishedAt);
    if (!parsedFinishedAt.success) throw new Error("Invalid refresh timestamp");
    const finishedAtMs = Date.parse(parsedFinishedAt.data);
    const fixedMessage = "Refresh interrupted during shutdown.";
    const diagnostic = {
      stage: "collection" as const,
      kind: "cancelled" as const,
      endpoint: null,
    };
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          "SELECT id, started_at_ms, record_json FROM refresh_runs ORDER BY started_at_ms, rowid",
        )
        .all() as unknown as RunRow[];
      let changed = 0;
      for (const row of rows) {
        let run: RefreshRun;
        try {
          run = RefreshRunSchema.parse(JSON.parse(row.record_json));
        } catch {
          throw new Error("Stored refresh history is invalid");
        }
        if (run.outcome !== "running" || row.started_at_ms > finishedAtMs)
          continue;
        const interrupted = RefreshRunSchema.parse({
          ...run,
          finishedAt: parsedFinishedAt.data,
          outcome: "interrupted",
          elapsedMs: Math.max(0, finishedAtMs - row.started_at_ms),
          errorCode: "unavailable",
          message: fixedMessage,
          diagnostic,
        });
        this.database
          .prepare("UPDATE refresh_runs SET record_json = ? WHERE id = ?")
          .run(JSON.stringify(interrupted), row.id);
        changed++;
      }
      if (changed > 0) this.bumpRevision();
      return changed;
    });
  }

  readPartitions(
    dates: string[],
    now: number,
    staleAfterSeconds: number,
  ): PartitionView[] {
    this.assertOpen();
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(staleAfterSeconds) ||
      staleAfterSeconds < 0
    ) {
      throw new Error("Invalid schedule query");
    }
    const validDates = dates.map((date) => LocalDateSchema.parse(date));
    const staleThreshold = Math.max(staleAfterSeconds, STALE_MINIMUM_SECONDS);
    const partitionQuery = this.database.prepare(
      "SELECT * FROM partitions WHERE local_date = ?",
    );
    const latestCheckQuery = this.database.prepare(
      "SELECT checked_at, state, error_code, message FROM partition_checks WHERE local_date = ? ORDER BY checked_at_ms DESC, id DESC LIMIT 1",
    );

    return validDates.map((localDate) => {
      const partition = partitionQuery.get(localDate) as
        | PartitionRow
        | undefined;
      const latest = latestCheckQuery.get(localDate) as CheckRow | undefined;
      const lastSuccessAt = partition?.last_success_at ?? null;
      const openings = partition
        ? parseOpenings(partition.openings_json).filter(
            (opening) => Date.parse(opening.startUtc) >= now,
          )
        : [];
      const errorCode = latest?.error_code ?? null;
      return {
        localDate,
        coverage: partition ? "complete" : "unknown",
        coverageStartUtc: partition?.coverage_start_utc ?? null,
        coverageEndUtc: partition?.coverage_end_utc ?? null,
        lastAttemptAt: latest?.checked_at ?? lastSuccessAt,
        lastSuccessAt,
        isStale:
          errorCode !== null ||
          !lastSuccessAt ||
          now - Date.parse(lastSuccessAt) > staleThreshold * 1000,
        errorCode: errorCode ? FailureCodeSchema.parse(errorCode) : null,
        message: latest ? checkMessage(latest) : null,
        openings,
      } satisfies PartitionView;
    });
  }

  readPreferences(): Preferences {
    this.assertOpen();
    const row = this.database
      .prepare("SELECT value_json FROM preferences WHERE id = 1")
      .get() as { value_json: string } | undefined;
    if (!row) return INITIAL_PREFERENCES;
    try {
      return PreferencesSchema.parse(JSON.parse(row.value_json));
    } catch {
      throw new Error("Stored preferences are invalid");
    }
  }

  updatePreferences(patch: Partial<Preferences>): Preferences {
    this.assertOpen();
    const parsedPatch = PreferencesPatchSchema.safeParse(patch);
    if (!parsedPatch.success) throw new Error("Invalid preferences");
    const merged = PreferencesSchema.safeParse({
      ...this.readPreferences(),
      ...parsedPatch.data,
    });
    if (!merged.success) throw new Error("Invalid preferences");
    const updated = merged.data;
    this.transaction(() => {
      const previous = this.readPreferences();
      if (JSON.stringify(previous) === JSON.stringify(updated)) return;
      this.database
        .prepare(
          "INSERT INTO preferences(id, value_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json",
        )
        .run(JSON.stringify(updated));
      this.bumpRevision();
    });
    return updated;
  }

  getStatus(): SourceStatus | undefined {
    this.assertOpen();
    const row = this.database
      .prepare("SELECT value_json FROM source_status WHERE id = 1")
      .get() as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return SourceStatusSchema.parse(JSON.parse(row.value_json));
    } catch {
      throw new Error("Stored source status is invalid");
    }
  }

  setStatus(status: SourceStatus): void {
    this.assertOpen();
    const parsed = SourceStatusSchema.safeParse({
      ...status,
      message: safeText(status.message),
    });
    if (!parsed.success) throw new Error("Invalid source status");
    const json = JSON.stringify(parsed.data);
    this.transaction(() => {
      const previous = this.database
        .prepare("SELECT value_json FROM source_status WHERE id = 1")
        .get() as { value_json: string } | undefined;
      if (previous?.value_json === json) return;
      this.database
        .prepare(
          "INSERT INTO source_status(id, value_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json",
        )
        .run(json);
      this.bumpRevision();
    });
  }

  revision(): string {
    this.assertOpen();
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'revision'")
      .get() as { value: string } | undefined;
    return row?.value ?? "0";
  }

  readPausedSessionRevision(): string | null | undefined {
    this.assertOpen();
    const row = this.database
      .prepare(
        "SELECT value FROM metadata WHERE key = 'paused-session-revision'",
      )
      .get() as { value: string } | undefined;
    if (!row) return undefined;
    const parsed: unknown = JSON.parse(row.value);
    if (parsed !== null && (typeof parsed !== "string" || parsed.length > 200))
      throw new Error("Stored scheduler metadata is invalid");
    return parsed as string | null;
  }

  readProviderNotBefore(): string | null {
    this.assertOpen();
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'provider-not-before'")
      .get() as { value: string } | undefined;
    return row ? InstantSchema.parse(row.value) : null;
  }

  setProviderNotBefore(value: string | null): void {
    this.assertOpen();
    const instant = value === null ? null : InstantSchema.parse(value);
    this.transaction(() => {
      if (instant === null)
        this.database
          .prepare("DELETE FROM metadata WHERE key = 'provider-not-before'")
          .run();
      else {
        const row = this.database
          .prepare(
            "SELECT value FROM metadata WHERE key = 'provider-not-before'",
          )
          .get() as { value: string } | undefined;
        if (!row || Date.parse(row.value) < Date.parse(instant))
          this.database
            .prepare(
              "INSERT INTO metadata(key,value) VALUES ('provider-not-before',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .run(instant);
      }
    });
  }

  clearExpiredProviderNotBefore(now: number): void {
    this.assertOpen();
    this.transaction(() => {
      const row = this.database
        .prepare("SELECT value FROM metadata WHERE key = 'provider-not-before'")
        .get() as { value: string } | undefined;
      if (row && Date.parse(row.value) <= now)
        this.database
          .prepare("DELETE FROM metadata WHERE key = 'provider-not-before'")
          .run();
    });
  }

  setPausedSessionRevision(value: string | null | undefined): void {
    this.assertOpen();
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" || value.length > 200)
    )
      throw new Error("Invalid scheduler metadata");
    this.transaction(() => {
      if (value === undefined)
        this.database
          .prepare("DELETE FROM metadata WHERE key = 'paused-session-revision'")
          .run();
      else
        this.database
          .prepare(
            "INSERT INTO metadata(key, value) VALUES ('paused-session-revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .run(JSON.stringify(value));
    });
  }

  prune(today: string, cutoffIso: string): void {
    this.assertOpen();
    const validToday = LocalDateSchema.parse(today);
    const validCutoff = InstantSchema.parse(cutoffIso);
    this.transaction(() => {
      const partitions = this.database
        .prepare("DELETE FROM partitions WHERE local_date < ?")
        .run(validToday).changes;
      const checks = this.database
        .prepare("DELETE FROM partition_checks WHERE checked_at_ms < ?")
        .run(Date.parse(validCutoff)).changes;
      const runs = this.database
        .prepare("DELETE FROM refresh_runs WHERE started_at_ms < ?")
        .run(Date.parse(validCutoff)).changes;
      if (partitions > 0 || checks > 0 || runs > 0) this.bumpRevision();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private migrate(): void {
    let version = Number(
      (
        this.database.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    );
    if (version > 3 || version < 0)
      throw new Error("Unsupported schedule storage version");
    if (version === 3) return;
    if (version === 1) {
      this.transaction(() =>
        this.database
          .exec(`ALTER TABLE partitions ADD COLUMN last_success_at TEXT;
        UPDATE partitions SET last_success_at = (SELECT checked_at FROM partition_checks WHERE partition_checks.local_date = partitions.local_date AND state = 'complete' ORDER BY checked_at_ms DESC, id DESC LIMIT 1);
        PRAGMA user_version = 2;`),
      );
      version = 2;
    }
    if (version === 0) {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE partitions (
            local_date TEXT PRIMARY KEY,
            coverage_start_utc TEXT NOT NULL,
            coverage_end_utc TEXT NOT NULL,
            openings_json TEXT NOT NULL,
            last_success_at TEXT NOT NULL
          );
          CREATE TABLE partition_checks (
            id INTEGER PRIMARY KEY,
            local_date TEXT NOT NULL,
            checked_at TEXT NOT NULL,
            checked_at_ms INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('complete', 'failed')),
            error_code TEXT,
            message TEXT
          );
          CREATE INDEX partition_checks_date_id ON partition_checks(local_date, id DESC);
          CREATE INDEX partition_checks_checked_at ON partition_checks(checked_at_ms);
          CREATE TABLE preferences (id INTEGER PRIMARY KEY CHECK (id = 1), value_json TEXT NOT NULL);
          CREATE TABLE source_status (id INTEGER PRIMARY KEY CHECK (id = 1), value_json TEXT NOT NULL);
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO metadata(key, value) VALUES ('revision', '0');
          INSERT INTO preferences(id, value_json) VALUES (1, '${JSON.stringify(INITIAL_PREFERENCES)}');
          PRAGMA user_version = 2;
        `);
      });
      version = 2;
    }
    if (version === 2) {
      this.transaction(() =>
        this.database.exec(`
          CREATE TABLE refresh_runs (
            id TEXT PRIMARY KEY,
            started_at_ms INTEGER NOT NULL,
            record_json TEXT NOT NULL
          );
          CREATE INDEX refresh_runs_started_at ON refresh_runs(started_at_ms DESC);
          PRAGMA user_version = 3;
        `),
      );
    }
  }

  private validateHistoryLimit(limit: number, maximum: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > maximum)
      throw new Error("Invalid diagnostics limit");
  }

  private bumpRevision(): void {
    this.database
      .prepare(
        "UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'",
      )
      .run();
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (error instanceof Error && error.message.startsWith("Invalid "))
        throw error;
      throw new Error("Schedule storage operation failed");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Schedule storage is closed");
  }
}
