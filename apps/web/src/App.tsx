import { DateTime } from "luxon";
import {
  BOOKING_URL,
  PreferencesSchema,
  RefreshResponseSchema,
  ScheduleResponseSchema,
  SourceStatusSchema,
  localToday,
  type Opening,
  type Preferences,
  type ScheduleResponse,
  type SourceStatus,
} from "../../../packages/contracts/src/index.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DiagnosticsPanel from "./DiagnosticsPanel.tsx";

const ZONE = "America/New_York";
const DURATION_OPTIONS = [
  { label: "Any duration", value: "any" },
  { label: "30+ minutes", value: "30" },
  { label: "60+ minutes", value: "60" },
  { label: "90+ minutes", value: "90" },
  { label: "120+ minutes", value: "120" },
] as const;

type SourcesResponse = { sources: SourceStatus[] };
type OpeningSelection = {
  opening: Opening;
  dateLabel: string;
  options?: Opening[];
};

async function apiJson<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return schema.parse(await response.json());
}

const SourcesResponseSchema = {
  parse(value: unknown): SourcesResponse {
    if (
      typeof value !== "object" ||
      value === null ||
      !Array.isArray((value as { sources?: unknown }).sources)
    ) {
      throw new Error("Source status response was not valid");
    }
    return {
      sources: (value as { sources: unknown[] }).sources.map((source) =>
        SourceStatusSchema.parse(source),
      ),
    };
  },
};

function dateLabel(
  date: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  },
) {
  return DateTime.fromISO(date, { zone: ZONE }).toLocaleString(options);
}

function timeLabel(time: string) {
  return DateTime.fromFormat(time, "HH:mm", { zone: ZONE }).toLocaleString(
    DateTime.TIME_SIMPLE,
  );
}

function formatObserved(instant: string | null) {
  if (!instant) return "Not observed yet";
  return DateTime.fromISO(instant)
    .setZone(ZONE)
    .toLocaleString({
      ...DateTime.DATETIME_MED_WITH_WEEKDAY,
      timeZoneName: "short",
    });
}

function messageForFailure(code: string | null) {
  switch (code) {
    case "needs-login":
      return "Reconnect McCarren to refresh this date.";
    case "rate-limited":
      return "McCarren is limiting requests. Cached starts are retained.";
    case "provider-blocked":
      return "McCarren could not be reached. Cached starts are retained.";
    case "parse-error":
      return "The provider schedule could not be read. Cached starts are retained.";
    case "incomplete":
      return "This date was only partially checked. Missing times are unknown.";
    case "unavailable":
      return "The source is unavailable. Cached starts are retained.";
    default:
      return "Coverage for this date is not known.";
  }
}

function sourceDueDescription(source: SourceStatus) {
  const dueAt = source.providerNotBefore ?? source.nextDueAt;
  if (!dueAt) return "";
  const label = source.providerNotBefore
    ? "Recorded provider not-before"
    : source.collectionPaused
      ? "Last scheduled due before pause"
      : "Next permitted check";
  return ` ${label}: ${formatObserved(dueAt)}.`;
}

function App() {
  const [anchorDate, setAnchorDate] = useState(() => localToday());
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [sourceStatus, setSourceStatus] = useState<SourceStatus | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(() =>
    PreferencesSchema.parse({}),
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState<OpeningSelection | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sequence = useRef(0);
  const preferenceQueue = useRef<Partial<Preferences>>({});
  const preferenceTimer = useRef<number | null>(null);
  const savingPreferences = useRef(false);
  const preferencesDirty = useRef(false);
  const preferenceGeneration = useRef(0);
  const preferencesHydrated = useRef(false);

  const dates = useMemo(() => {
    const start = DateTime.fromISO(anchorDate, { zone: ZONE });
    const count = preferences.view === "week" ? 7 : 1;
    return Array.from(
      { length: count },
      (_, index) => start.plus({ days: index }).toISODate()!,
    );
  }, [anchorDate, preferences.view]);
  const rangeFrom = dates[0] ?? anchorDate;

  const loadData = useCallback(async () => {
    const requestSequence = ++sequence.current;
    const readPreferenceGeneration = preferenceGeneration.current;
    setLoadError(null);
    try {
      const query = new URLSearchParams({ from: rangeFrom, days: "7" });
      const [response, sources, savedPreferences] = await Promise.all([
        apiJson(`/api/schedule?${query}`, ScheduleResponseSchema),
        apiJson("/api/sources", SourcesResponseSchema),
        apiJson("/api/preferences", PreferencesSchema),
      ]);
      if (requestSequence !== sequence.current) return;
      setSchedule(response);
      setSourceStatus(
        sources.sources.find((source) => source.id === "mccarren") ??
          response.source,
      );
      if (
        !preferencesHydrated.current &&
        !preferencesDirty.current &&
        readPreferenceGeneration === preferenceGeneration.current
      ) {
        setPreferences(savedPreferences);
        preferencesHydrated.current = true;
      }
      setLoading(false);
    } catch (error) {
      if (requestSequence !== sequence.current) return;
      setLoadError(
        error instanceof Error
          ? error.message
          : "Could not load McCarren schedule.",
      );
      setLoading(false);
    }
  }, [rangeFrom]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => void loadData(), 15_000);
    const onFocus = () => void loadData();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadData]);

  const flushPreferenceQueue = useCallback(async () => {
    if (savingPreferences.current) return;
    savingPreferences.current = true;
    try {
      while (Object.keys(preferenceQueue.current).length > 0) {
        const patch = preferenceQueue.current;
        preferenceQueue.current = {};
        const saved = await apiJson("/api/preferences", PreferencesSchema, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        preferenceGeneration.current++;
        preferencesHydrated.current = true;
        setPreferences((current) => {
          const pendingKeys = new Set(Object.keys(preferenceQueue.current));
          return PreferencesSchema.parse(
            Object.fromEntries(
              Object.entries(saved).map(([key, value]) => [
                key,
                pendingKeys.has(key)
                  ? current[key as keyof Preferences]
                  : value,
              ]),
            ),
          );
        });
      }
      preferencesDirty.current = false;
      setPreferenceError(null);
    } catch (error) {
      setPreferenceError(
        error instanceof Error ? error.message : "Could not save preferences.",
      );
      preferenceQueue.current = {};
      preferencesDirty.current = false;
    } finally {
      savingPreferences.current = false;
      if (Object.keys(preferenceQueue.current).length > 0)
        void flushPreferenceQueue();
    }
  }, []);

  const updatePreferences = (patch: Partial<Preferences>) => {
    preferenceGeneration.current++;
    preferencesDirty.current = true;
    setPreferences((current) =>
      PreferencesSchema.parse({ ...current, ...patch }),
    );
    preferenceQueue.current = { ...preferenceQueue.current, ...patch };
    if (preferenceTimer.current) window.clearTimeout(preferenceTimer.current);
    preferenceTimer.current = window.setTimeout(
      () => void flushPreferenceQueue(),
      250,
    );
  };

  useEffect(
    () => () => {
      if (preferenceTimer.current) window.clearTimeout(preferenceTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (selection && dialogRef.current && !dialogOpen) {
      dialogRef.current.showModal();
      setDialogOpen(true);
    }
  }, [selection, dialogOpen]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      const response = await apiJson(
        "/api/refresh-requests",
        RefreshResponseSchema,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      const label =
        response.status === "accepted"
          ? "Refresh requested"
          : response.status === "coalesced"
            ? "Refresh already in progress"
            : sourceStatus?.collectionPaused
              ? "Collection is paused locally"
              : "Refresh deferred by the source schedule";
      const providerNotBefore =
        response.providerNotBefore ?? sourceStatus?.providerNotBefore;
      const dueAt = providerNotBefore ?? response.nextDueAt;
      const dueLabel = providerNotBefore
        ? "recorded provider not-before"
        : sourceStatus?.collectionPaused
          ? "last scheduled due before pause"
          : "next due";
      setRefreshMessage(
        dueAt ? `${label} · ${dueLabel} ${formatObserved(dueAt)}` : label,
      );
      if (response.status === "accepted" || response.status === "coalesced")
        window.setTimeout(() => void loadData(), 800);
    } catch (error) {
      setRefreshMessage(
        error instanceof Error
          ? `Refresh unavailable: ${error.message}`
          : "Refresh unavailable.",
      );
    } finally {
      setRefreshing(false);
    }
  };

  const allOpenings = useMemo(
    () => schedule?.partitions.flatMap((partition) => partition.openings) ?? [],
    [schedule],
  );
  const courtOptions = useMemo(() => {
    const byId = new Map<number, string>();
    allOpenings.forEach((opening) =>
      byId.set(opening.courtId, opening.courtLabel),
    );
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [allOpenings]);
  const visibleOpenings = useMemo(
    () =>
      allOpenings.filter((opening) => {
        if (
          preferences.courtIds.length > 0 &&
          !preferences.courtIds.includes(opening.courtId)
        )
          return false;
        if (preferences.durationMinutes === null) return true;
        if (opening.durationMinutes === null)
          return preferences.includeUnknownDuration;
        return opening.durationMinutes >= preferences.durationMinutes;
      }),
    [allOpenings, preferences],
  );
  const openingsByDateAndTime = useMemo(() => {
    const result = new Map<string, Opening[]>();
    for (const opening of visibleOpenings) {
      if (!dates.includes(opening.localDate)) continue;
      const key = `${opening.localDate}|${opening.localTime}`;
      result.set(key, [...(result.get(key) ?? []), opening]);
    }
    return result;
  }, [visibleOpenings, dates]);
  const times = useMemo(
    () =>
      [
        ...new Set(
          visibleOpenings
            .filter((opening) => dates.includes(opening.localDate))
            .map((opening) => opening.localTime),
        ),
      ].sort(),
    [visibleOpenings, dates],
  );
  const today = localToday();

  const changeAnchor = (offset: number) => {
    setAnchorDate(
      DateTime.fromISO(anchorDate, { zone: ZONE })
        .plus({ days: offset })
        .toISODate()!,
    );
  };

  const setCourtSelected = (courtId: number, selected: boolean) => {
    const ids = new Set(
      preferences.courtIds.length > 0
        ? preferences.courtIds
        : courtOptions.map(([id]) => id),
    );
    if (selected) ids.add(courtId);
    else ids.delete(courtId);
    if (ids.size === 0) return;
    updatePreferences({ courtIds: [...ids].sort((a, b) => a - b) });
  };

  const handleDialogClose = () => {
    setDialogOpen(false);
    setSelection(null);
  };

  const loadingContent = loading && !schedule;
  const source = sourceStatus ?? schedule?.source ?? null;

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="McCarren schedule controls">
        <a
          className="brand"
          href="#calendar"
          aria-label="Rally, McCarren court openings"
        >
          <span className="brand-mark" aria-hidden="true">
            R
          </span>
          <span>
            rally<span className="brand-period">.</span>
          </span>
        </a>
        <section className="venue-card" aria-labelledby="venue-heading">
          <div className="venue-card-top">
            <span className="venue-icon" aria-hidden="true">
              ⌁
            </span>
            <span className="venue-indoor">INDOOR</span>
          </div>
          <h2 id="venue-heading">
            McCarren
            <br />
            Tennis Center
          </h2>
          <p>Brooklyn · New York</p>
          <span className="venue-address">Indoor court starts</span>
        </section>

        <div className="side-section">
          <h2 className="side-heading">REFINE STARTS</h2>
          <label className="field-label" htmlFor="duration">
            Minimum duration
          </label>
          <select
            id="duration"
            value={preferences.durationMinutes ?? "any"}
            onChange={(event) =>
              updatePreferences({
                durationMinutes:
                  event.target.value === "any"
                    ? null
                    : (Number(
                        event.target.value,
                      ) as Preferences["durationMinutes"]),
              })
            }
          >
            {DURATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {preferences.durationMinutes !== null && (
            <div className="unknown-choice">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={preferences.includeUnknownDuration}
                  onChange={(event) =>
                    updatePreferences({
                      includeUnknownDuration: event.target.checked,
                    })
                  }
                />
                <span>Include starts with unknown duration</span>
              </label>
              <p>
                These starts have no published length; they are not assumed to
                meet the selected minimum.
              </p>
            </div>
          )}
        </div>

        {courtOptions.length > 0 && (
          <fieldset className="side-section court-filter">
            <legend className="side-heading">COURTS OBSERVED</legend>
            <p className="filter-hint">Labels reflect provider inventory.</p>
            {courtOptions.map(([id, label]) => (
              <label className="checkbox-label" key={id}>
                <input
                  type="checkbox"
                  checked={
                    preferences.courtIds.length === 0 ||
                    preferences.courtIds.includes(id)
                  }
                  disabled={
                    preferences.courtIds.length === 1 &&
                    preferences.courtIds[0] === id
                  }
                  onChange={(event) =>
                    setCourtSelected(id, event.target.checked)
                  }
                />
                <span>{label}</span>
              </label>
            ))}
            {preferences.courtIds.length > 0 && (
              <button
                className="text-button clear-courts"
                onClick={() => updatePreferences({ courtIds: [] })}
              >
                Show all observed courts
              </button>
            )}
          </fieldset>
        )}

        <div className="connector-card" aria-live="polite">
          <div className="connector-title">
            <span
              className={`health-dot health-${source?.health ?? "error"}`}
              aria-hidden="true"
            />
            <span>McCarren source</span>
          </div>
          <p className="connector-health">
            {source ? source.health.replaceAll("-", " ") : "Status unavailable"}
          </p>
          <p className="connector-message">
            {source?.message ?? "Source status could not be loaded."}
          </p>
          {source && (
            <p className="connector-detail">
              {source.collectionPaused
                ? "Automatic and manual collection are paused locally."
                : `Automatic checks every ${source.cadenceSeconds} seconds while the service is running.`}
            </p>
          )}
          <p className="connector-detail">
            {source?.sessionPresent ? "Session saved" : "Not connected"} ·{" "}
            {source?.lastSuccessAt
              ? `Last checked ${formatObserved(source.lastSuccessAt)}`
              : "No successful check yet"}
          </p>
          {!source?.collectionPaused &&
            (!source?.sessionPresent ||
              source.health === "needs-login" ||
              source.health === "provider-blocked") && (
              <p className="reconnect-hint">
                Reconnect command: <code>make connect</code>
              </p>
            )}
        </div>
        <p className="sidebar-footnote">
          Read-only schedule · Booking always stays with McCarren.
        </p>
      </aside>

      <main id="calendar" className="main-content">
        <header className="page-header">
          <div>
            <p className="eyebrow">
              COURT AVAILABILITY <span aria-hidden="true">/</span> BROOKLYN
            </p>
            <h1>
              Find your next
              <br className="mobile-break" /> <em>court time.</em>
            </h1>
            <p className="page-intro">
              A clear view of McCarren's indoor starts. Each marker is a
              separate option from the provider.
            </p>
          </div>
          <button
            className="refresh-button"
            onClick={() => void refresh()}
            disabled={refreshing || sourceStatus?.collectionPaused === true}
            aria-label={
              sourceStatus?.collectionPaused
                ? "Collection paused locally"
                : "Request a schedule refresh"
            }
          >
            <span
              className={refreshing ? "refresh-icon spinning" : "refresh-icon"}
              aria-hidden="true"
            >
              ↻
            </span>
            {refreshing
              ? "Requesting…"
              : sourceStatus?.collectionPaused
                ? "Paused"
                : "Refresh"}
          </button>
        </header>

        <section
          className="calendar-section"
          aria-labelledby="calendar-heading"
        >
          <div className="calendar-toolbar">
            <div>
              <h2 id="calendar-heading">Your court calendar</h2>
              <p className="range-caption">
                {preferences.view === "week"
                  ? `${dateLabel(dates[0]!, { month: "long", day: "numeric" })} – ${dateLabel(dates[6]!, { month: "long", day: "numeric", year: "numeric" })}`
                  : dateLabel(dates[0]!, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
              </p>
            </div>
            <div className="calendar-actions">
              <div
                className="view-toggle"
                role="group"
                aria-label="Calendar view"
              >
                <button
                  aria-pressed={preferences.view === "week"}
                  onClick={() => updatePreferences({ view: "week" })}
                >
                  Week
                </button>
                <button
                  aria-pressed={preferences.view === "day"}
                  onClick={() => updatePreferences({ view: "day" })}
                >
                  Day
                </button>
              </div>
              <div className="date-nav" aria-label="Change displayed dates">
                <button
                  className="icon-button"
                  onClick={() =>
                    changeAnchor(preferences.view === "week" ? -7 : -1)
                  }
                  aria-label={
                    preferences.view === "week"
                      ? "Previous week"
                      : "Previous day"
                  }
                >
                  ‹
                </button>
                <button
                  className="today-button"
                  onClick={() => setAnchorDate(today)}
                >
                  Today
                </button>
                <button
                  className="icon-button"
                  onClick={() =>
                    changeAnchor(preferences.view === "week" ? 7 : 1)
                  }
                  aria-label={
                    preferences.view === "week" ? "Next week" : "Next day"
                  }
                >
                  ›
                </button>
              </div>
            </div>
          </div>

          {source &&
            (source.collectionPaused ||
              !["healthy", "refreshing"].includes(source.health)) && (
              <div className="alert alert-error" role="status">
                <div>
                  <strong>
                    {source.lastSuccessAt
                      ? "Showing cached openings — live collection is unavailable."
                      : "Live availability has not been verified."}
                  </strong>
                  <p>
                    {source.collectionPaused
                      ? "Collection is paused locally; no automatic or manual provider requests will be sent. "
                      : source.message}
                    {sourceDueDescription(source)} Open Refresh activity &
                    diagnostics below for details.
                  </p>
                </div>
              </div>
            )}
          {loadError && (
            <div className="alert alert-error" role="alert">
              <div>
                <strong>
                  {schedule
                    ? "Schedule could not be updated"
                    : "Schedule unavailable"}
                </strong>
                <p>
                  {loadError}
                  {schedule
                    ? " Previously loaded data remains visible; check its freshness labels."
                    : " No empty state is inferred from a failed request."}
                </p>
              </div>
              <button className="text-button" onClick={() => void loadData()}>
                Try again
              </button>
            </div>
          )}
          {preferenceError && (
            <div className="alert alert-error" role="alert">
              <div>
                <strong>Preferences could not be saved</strong>
                <p>
                  {preferenceError}. Current display choices remain local to
                  this page.
                </p>
              </div>
            </div>
          )}
          {refreshMessage && (
            <p className="refresh-feedback" role="status">
              {refreshMessage}
            </p>
          )}

          {loadingContent ? (
            <div className="loading-panel" role="status" aria-busy="true">
              <span className="loading-mark" aria-hidden="true" />
              <div>
                <strong>Loading McCarren schedule</strong>
                <p>Checking cached availability and source coverage…</p>
              </div>
            </div>
          ) : (
            schedule && (
              <>
                <div
                  className="calendar-legend"
                  aria-label="Schedule information"
                >
                  <span>
                    <i className="legend-marker" aria-hidden="true" /> Separate
                    provider start
                  </span>
                  <span>Duration and price shown only when published</span>
                  {loading && (
                    <span className="updating-label" aria-live="polite">
                      Updating cached view…
                    </span>
                  )}
                </div>
                <CalendarGrid
                  dates={dates}
                  times={times}
                  schedule={schedule}
                  visibleOpenings={visibleOpenings}
                  openingsByDateAndTime={openingsByDateAndTime}
                  today={today}
                  onSelect={(opening, options) =>
                    setSelection({
                      opening,
                      options,
                      dateLabel: dateLabel(opening.localDate, {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                      }),
                    })
                  }
                  onFocusDay={(date) => {
                    setAnchorDate(date);
                    updatePreferences({ view: "day" });
                  }}
                />
                <p className="coverage-note">
                  A listed start is not a confirmed reservation. Unlisted times
                  may be unavailable, outside checked coverage, or unknown.
                </p>
              </>
            )
          )}
        </section>
        <DiagnosticsPanel />
        <footer className="page-footer">
          <span>McCarren Tennis Center · New York time</span>
          <span>Booking opens on the provider's site</span>
          <a href="/architecture">Explore the architecture</a>
        </footer>
      </main>

      <dialog
        ref={dialogRef}
        className="opening-dialog"
        aria-labelledby="detail-heading"
        onClose={handleDialogClose}
      >
        {selection && (
          <div className="dialog-inner">
            <div className="dialog-top">
              <span className="dialog-kicker">MCCARREN · INDOOR</span>
              <button
                className="icon-button close-button"
                onClick={() => dialogRef.current?.close()}
                aria-label="Close opening details"
              >
                ×
              </button>
            </div>
            <h2 id="detail-heading">Court start</h2>
            <p className="detail-date">
              {selection.dateLabel} · {timeLabel(selection.opening.localTime)}
            </p>
            {selection.options && selection.options.length > 1 && (
              <fieldset className="court-choice-list">
                <legend>Separate court starts at this time</legend>
                {selection.options.map((option) => (
                  <label className="checkbox-label" key={option.id}>
                    <input
                      type="radio"
                      name="court-start"
                      checked={selection.opening.id === option.id}
                      onChange={() =>
                        setSelection({ ...selection, opening: option })
                      }
                    />
                    <span>
                      {option.courtLabel}
                      {option.durationMinutes === null
                        ? " · length unknown"
                        : ` · ${option.durationMinutes} min`}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <dl className="detail-list">
              <div>
                <dt>Court</dt>
                <dd>{selection.opening.courtLabel}</dd>
              </div>
              <div>
                <dt>Start time</dt>
                <dd>
                  {DateTime.fromISO(selection.opening.startUtc)
                    .setZone(ZONE)
                    .toLocaleString(DateTime.DATETIME_MED_WITH_WEEKDAY)}
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>
                  {selection.opening.durationMinutes === null
                    ? "Not published"
                    : `${selection.opening.durationMinutes} minutes`}
                </dd>
              </div>
              <div>
                <dt>Price</dt>
                <dd>
                  {selection.opening.price === null
                    ? "Unknown"
                    : `${new Intl.NumberFormat("en-US", { style: "currency", currency: selection.opening.price.currency }).format(selection.opening.price.amount)} · ${selection.opening.price.basis}`}
                </dd>
              </div>
              <div>
                <dt>Eligibility</dt>
                <dd>
                  {selection.opening.eligibility === "unknown"
                    ? "Not verified"
                    : selection.opening.eligibility}
                </dd>
              </div>
              <div>
                <dt>Observed</dt>
                <dd>{formatObserved(selection.opening.observedAt)}</dd>
              </div>
            </dl>
            <p className="booking-note">
              This is a separate provider start, not a confirmed booking.
              Confirm the option and any requirements on McCarren's site.
            </p>
            <a
              className="booking-link"
              href={
                selection.opening.bookingUrl === BOOKING_URL
                  ? BOOKING_URL
                  : undefined
              }
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open McCarren booking site in a new tab"
            >
              Continue to McCarren <span aria-hidden="true">↗</span>
            </a>
            <p className="booking-instructions">
              Use the date and start time above to find this option. The
              provider may not preselect it.
            </p>
          </div>
        )}
      </dialog>
    </div>
  );
}

type CalendarGridProps = {
  dates: string[];
  times: string[];
  schedule: ScheduleResponse;
  visibleOpenings: Opening[];
  openingsByDateAndTime: Map<string, Opening[]>;
  today: string;
  onSelect: (opening: Opening, options?: Opening[]) => void;
  onFocusDay: (date: string) => void;
};

function CalendarGrid({
  dates,
  times,
  schedule,
  visibleOpenings,
  openingsByDateAndTime,
  today,
  onSelect,
  onFocusDay,
}: CalendarGridProps) {
  const partitions = new Map(
    schedule.partitions.map((partition) => [partition.localDate, partition]),
  );
  return (
    <>
      <div
        className={`calendar-grid ${dates.length === 1 ? "day-grid" : ""}`}
        role="table"
        aria-label={`${dates.length === 1 ? "Day" : "Week"} view of McCarren court starts`}
      >
        <div className="grid-header" role="row">
          <div className="time-column-head" role="columnheader">
            START
          </div>
          {dates.map((date) => (
            <div
              className={`date-column-head ${date === today ? "is-today" : ""}`}
              role="columnheader"
              key={date}
            >
              <span className="day-name">
                {dateLabel(date, { weekday: "short" })}
              </span>
              <span className="day-number">
                {DateTime.fromISO(date, { zone: ZONE }).day}
              </span>
              {date === today && <span className="today-label">TODAY</span>}
              <button
                className="focus-day-button"
                onClick={() => onFocusDay(date)}
                aria-label={`Focus ${dateLabel(date, { weekday: "long", month: "long", day: "numeric" })}`}
              >
                View day
              </button>
            </div>
          ))}
        </div>
        <div className="calendar-body" role="rowgroup">
          {times.length > 0 ? (
            times.map((time) => (
              <div className="time-row" role="row" key={time}>
                <div className="time-label" role="rowheader">
                  {timeLabel(time)}
                </div>
                {dates.map((date) => (
                  <div
                    className={`time-cell ${date === today ? "is-today" : ""}`}
                    role="cell"
                    key={`${date}-${time}`}
                  >
                    <OpeningChoices
                      openings={
                        openingsByDateAndTime.get(`${date}|${time}`) ?? []
                      }
                      group={dates.length > 1}
                      onSelect={onSelect}
                    />
                  </div>
                ))}
              </div>
            ))
          ) : (
            <div className="no-times-row">
              <span aria-hidden="true">—</span>
              <p>
                {visibleOpenings.length === 0 &&
                schedule.partitions.some(
                  (partition) => partition.coverage === "complete",
                )
                  ? "No starts match the selected filters."
                  : "No confirmed starts are currently listed for these dates."}
              </p>
            </div>
          )}
        </div>
        <div className="coverage-row" role="rowgroup">
          {dates.map((date) => (
            <div className="coverage-cell" key={`coverage-${date}`}>
              <PartitionStatus partition={partitions.get(date)} />
              {partitions.get(date)?.coverage === "complete" &&
                !visibleOpenings.some(
                  (opening) => opening.localDate === date,
                ) && (
                  <p className="checked-empty">
                    {partitions.get(date)?.openings.length
                      ? "No starts match filters"
                      : "No starts in checked schedule"}
                  </p>
                )}
            </div>
          ))}
        </div>
      </div>
      <div className="mobile-list" aria-label="Court starts by day">
        {dates.map((date) => {
          const partition = partitions.get(date);
          const dayOpenings = visibleOpenings.filter(
            (opening) => opening.localDate === date,
          );
          return (
            <section
              className={`mobile-day-card ${date === today ? "is-today" : ""}`}
              aria-labelledby={`list-date-${date}`}
              key={date}
            >
              <div className="mobile-day-heading">
                <h3 id={`list-date-${date}`}>
                  {dateLabel(date, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  })}
                </h3>
                {date === today && <span className="today-label">TODAY</span>}
              </div>
              <PartitionStatus partition={partition} />
              {dayOpenings.length ? (
                <ul className="mobile-start-list">
                  {dayOpenings.map((opening) => (
                    <li key={opening.id}>
                      <OpeningMarker opening={opening} onSelect={onSelect} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mobile-empty">
                  {partition?.coverage === "complete"
                    ? "No starts match these filters in the checked schedule."
                    : "No confirmed starts to show. Coverage is unknown."}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

function PartitionStatus({
  partition,
}: {
  partition: ScheduleResponse["partitions"][number] | undefined;
}) {
  if (partition?.errorCode)
    return (
      <span className="coverage-status coverage-error">
        {messageForFailure(partition.errorCode)}
        {partition.lastSuccessAt
          ? ` Last success ${formatObserved(partition.lastSuccessAt)}.`
          : ""}
      </span>
    );
  if (!partition || partition.coverage === "unknown")
    return (
      <span className="coverage-status coverage-unknown">Coverage unknown</span>
    );
  if (partition.isStale)
    return (
      <span className="coverage-status coverage-stale">
        Cached · last checked {formatObserved(partition.lastSuccessAt)}
      </span>
    );
  return (
    <span className="coverage-status coverage-complete">
      Checked · {formatObserved(partition.lastSuccessAt)}
    </span>
  );
}

function OpeningMarker({
  opening,
  onSelect,
}: {
  opening: Opening;
  onSelect: (opening: Opening) => void;
}) {
  return (
    <div className="opening-item">
      <button
        className="opening-marker"
        data-choice-count="1"
        onClick={() => onSelect(opening)}
        aria-label={`${timeLabel(opening.localTime)}, ${opening.courtLabel}, ${opening.durationMinutes === null ? "duration not published" : `${opening.durationMinutes} minutes`}`}
      >
        <span className="marker-dot" aria-hidden="true" />
        <span className="marker-time">{timeLabel(opening.localTime)}</span>
        <span className="marker-court">{opening.courtLabel}</span>
        <span className="marker-duration">
          {opening.durationMinutes === null
            ? "Length unknown"
            : `${opening.durationMinutes} min`}
        </span>
      </button>
    </div>
  );
}

function OpeningChoices({
  openings,
  group,
  onSelect,
}: {
  openings: Opening[];
  group: boolean;
  onSelect: (opening: Opening, options?: Opening[]) => void;
}) {
  if (!openings.length) return null;
  if (!group || openings.length === 1)
    return (
      <>
        {openings.map((opening) => (
          <OpeningMarker
            key={opening.id}
            opening={opening}
            onSelect={onSelect}
          />
        ))}
      </>
    );
  const first = openings[0]!;
  return (
    <div className="opening-item">
      <button
        className="opening-marker opening-group"
        data-choice-count={openings.length}
        onClick={() => onSelect(first, openings)}
        aria-label={`${timeLabel(first.localTime)}, ${openings.length} separate court starts, choose a court`}
      >
        <span className="marker-dot" aria-hidden="true" />
        <span className="marker-time">{timeLabel(first.localTime)}</span>
        <span className="marker-court">{openings.length} court starts</span>
        <span className="marker-duration">View ↗</span>
      </button>
    </div>
  );
}

export default App;
