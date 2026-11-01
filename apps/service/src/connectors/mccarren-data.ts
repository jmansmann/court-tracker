import { DateTime } from "luxon";

const ORGANIZATION_ID = 10243 as const;
const TIME_ZONE = "America/New_York" as const;
const MAX_COURTS = 50;
const MAX_SCHEDULE_ROWS = 5000;
const CELL_KEYS = ["start", "court", "label", "testid", "text"];

export interface ProbeConfiguration {
  organizationId: typeof ORGANIZATION_ID;
  timeZone: typeof TIME_ZONE;
  minIntervalMinutes: number;
  bookingDays: number;
  gridStartTime: string;
  gridEndTime: string;
  courts: { id: number; label: string }[];
}

export interface NativeOpeningMarker {
  kind: "reserve-start-marker";
  courtId: number;
  courtLabel: string;
  localDate: string;
  localTime: string;
  startUtc: string;
  gridIntervalMinutes: number;
  bookableDurationMinutes: null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }
  const parsed = DateTime.fromISO(date, { zone: TIME_ZONE });
  return parsed.isValid && parsed.toISODate() === date;
}

function dateError(): Error {
  return new Error("Invalid McCarren local date");
}

function configurationError(): Error {
  return new Error("Invalid McCarren configuration payload");
}

function configuredTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = DateTime.fromFormat(value, "yyyy-MM-dd HH:mm:ss", {
    zone: TIME_ZONE,
    setZone: true,
  });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd HH:mm:ss") !== value) {
    return undefined;
  }
  return parsed.toFormat("HH:mm");
}

function scheduleError(): Error {
  return new Error("Invalid McCarren schedule payload");
}

/** Validate and retain the small, non-sensitive part of CourtReserve setup data. */
export function parseConfiguration(payload: unknown): ProbeConfiguration {
  if (!record(payload) || payload.IsValid !== true || !record(payload.Data)) {
    throw configurationError();
  }
  const model = payload.Data.Model;
  if (
    !record(model) ||
    model.OrgId !== ORGANIZATION_ID ||
    model.TimeZone !== TIME_ZONE ||
    configuredTime(model.StartTimeStringDisplay) === undefined ||
    configuredTime(model.EndTimeStringDisplay) === undefined ||
    !Number.isInteger(model.MinInterval) ||
    (model.MinInterval as number) < 1 ||
    (model.MinInterval as number) > 120 ||
    !Number.isInteger(model.DaysACourtCanBeReservedInAdvance) ||
    (model.DaysACourtCanBeReservedInAdvance as number) < 0 ||
    (model.DaysACourtCanBeReservedInAdvance as number) > 365 ||
    (configuredTime(model.EndTimeStringDisplay) as string) <=
      (configuredTime(model.StartTimeStringDisplay) as string) ||
    !Array.isArray(model.Courts) ||
    model.Courts.length < 1 ||
    model.Courts.length > MAX_COURTS
  ) {
    throw configurationError();
  }

  const ids = new Set<number>();
  const labels = new Set<string>();
  const courts: ProbeConfiguration["courts"] = [];
  for (const court of model.Courts) {
    if (
      !record(court) ||
      !Number.isInteger(court.Id) ||
      (court.Id as number) < 1 ||
      typeof court.Label !== "string" ||
      court.Label.length < 1 ||
      court.Label.length > 100 ||
      ids.has(court.Id as number) ||
      labels.has(court.Label)
    ) {
      throw configurationError();
    }
    ids.add(court.Id as number);
    labels.add(court.Label);
    courts.push({ id: court.Id as number, label: court.Label });
  }

  return {
    organizationId: ORGANIZATION_ID,
    timeZone: TIME_ZONE,
    minIntervalMinutes: model.MinInterval as number,
    bookingDays: model.DaysACourtCanBeReservedInAdvance as number,
    gridStartTime: configuredTime(model.StartTimeStringDisplay) as string,
    gridEndTime: configuredTime(model.EndTimeStringDisplay) as string,
    courts,
  };
}

/** Validate the observed schedule URL without ever echoing its query values. */
export function parseScheduleQuery(url: string): {
  date: string;
  organizationId: typeof ORGANIZATION_ID;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid McCarren schedule query URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "backend.courtreserve.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/api/scheduler/member-expanded" ||
    parsed.hash !== ""
  ) {
    throw new Error("Invalid McCarren schedule query URL");
  }

  const encoded = parsed.searchParams.getAll("jsonData");
  if (encoded.length !== 1) {
    throw new Error("Invalid McCarren schedule query parameters");
  }
  let query: unknown;
  try {
    query = JSON.parse(encoded[0] as string);
  } catch {
    throw new Error("Invalid McCarren schedule query parameters");
  }
  if (
    !record(query) ||
    query.orgId !== ORGANIZATION_ID ||
    query.timeZone !== TIME_ZONE ||
    !isValidDate(query.selectedDate)
  ) {
    throw new Error("Invalid McCarren schedule query parameters");
  }
  return { date: query.selectedDate, organizationId: ORGANIZATION_ID };
}

function isOffsetIso(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return false;
  }
  return DateTime.fromISO(value, { setZone: true }).isValid;
}

/** Summarize validated schedule rows without retaining or interpreting player data. */
export function parseScheduleSummary(payload: unknown): {
  rows: number;
  total: number;
  complete: boolean;
} {
  if (
    !record(payload) ||
    payload.Errors !== null ||
    !Array.isArray(payload.Data) ||
    payload.Data.length > MAX_SCHEDULE_ROWS ||
    !Number.isInteger(payload.Total) ||
    (payload.Total as number) < payload.Data.length
  ) {
    throw scheduleError();
  }

  for (const row of payload.Data) {
    if (
      !record(row) ||
      !isOffsetIso(row.Start) ||
      !isOffsetIso(row.End) ||
      DateTime.fromISO(row.End as string, { setZone: true }).toMillis() <=
        DateTime.fromISO(row.Start as string, { setZone: true }).toMillis()
    ) {
      throw scheduleError();
    }
  }

  const rows = payload.Data.length;
  const total = payload.Total as number;
  return { rows, total, complete: total === rows };
}

function normalizeConfig(config: ProbeConfiguration): Map<string, number> {
  if (
    !record(config) ||
    config.organizationId !== ORGANIZATION_ID ||
    config.timeZone !== TIME_ZONE ||
    !Number.isInteger(config.minIntervalMinutes) ||
    config.minIntervalMinutes < 1 ||
    config.minIntervalMinutes > 120 ||
    !/^\d{2}:\d{2}$/.test(config.gridStartTime) ||
    !/^\d{2}:\d{2}$/.test(config.gridEndTime) ||
    !Array.isArray(config.courts)
  ) {
    throw new Error("Invalid McCarren marker configuration");
  }
  const courtIds = new Map<string, number>();
  for (const court of config.courts) {
    if (
      !record(court) ||
      !Number.isInteger(court.id) ||
      typeof court.label !== "string" ||
      court.label.length < 1 ||
      court.label.length > 100 ||
      courtIds.has(court.label)
    ) {
      throw new Error("Invalid McCarren marker configuration");
    }
    courtIds.set(court.label, court.id as number);
  }
  return courtIds;
}

/** Convert only individually observed Reserve controls into native start markers. */
export function normalizeCells(
  cells: unknown,
  config: ProbeConfiguration,
  date: string,
): NativeOpeningMarker[] {
  const courtIds = normalizeConfig(config);
  if (!isValidDate(date)) throw dateError();
  if (!Array.isArray(cells) || cells.length > MAX_SCHEDULE_ROWS) {
    throw new Error("Invalid McCarren reserve-cell data");
  }

  const seen = new Set<string>();
  const markers: NativeOpeningMarker[] = [];
  for (const cell of cells) {
    if (
      !record(cell) ||
      Object.keys(cell).some((key) => !CELL_KEYS.includes(key)) ||
      Object.keys(cell).length !== CELL_KEYS.length ||
      typeof cell.start !== "string" ||
      !/^\d{2}:\d{2}$/.test(cell.start) ||
      typeof cell.court !== "string" ||
      typeof cell.label !== "string" ||
      cell.testid !== "reserve-slot-btn" ||
      cell.text !== "Reserve"
    ) {
      throw new Error("Invalid McCarren reserve-cell data");
    }

    const courtId = courtIds.get(cell.court);
    const [hourText, minuteText] = cell.start.split(":");
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (courtId === undefined || hour > 23 || minute > 59) {
      throw new Error("Invalid McCarren reserve-cell data");
    }
    const local = DateTime.fromObject(
      {
        year: Number(date.slice(0, 4)),
        month: Number(date.slice(5, 7)),
        day: Number(date.slice(8, 10)),
        hour,
        minute,
      },
      { zone: TIME_ZONE },
    );
    if (
      !local.isValid ||
      local.year !== Number(date.slice(0, 4)) ||
      local.month !== Number(date.slice(5, 7)) ||
      local.day !== Number(date.slice(8, 10)) ||
      local.hour !== hour ||
      local.minute !== minute ||
      local.getPossibleOffsets().length !== 1
    ) {
      throw new Error("Invalid McCarren reserve-cell data");
    }
    const localTime = local.toFormat("h:mm a");
    if (cell.label !== `Reserve ${cell.court} ${localTime}`) {
      throw new Error("Invalid McCarren reserve-cell data");
    }

    const key = `${courtId}\u0000${local.toMillis()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({
      kind: "reserve-start-marker",
      courtId,
      courtLabel: cell.court,
      localDate: date,
      localTime: cell.start,
      startUtc: local.toUTC().toISO({ suppressMilliseconds: true }) as string,
      gridIntervalMinutes: config.minIntervalMinutes,
      bookableDurationMinutes: null,
    });
  }
  return markers;
}
