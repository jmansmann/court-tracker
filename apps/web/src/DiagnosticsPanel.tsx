import { DateTime } from "luxon";
import {
  DiagnosticsResponseSchema,
  type ConnectorDiagnostic,
  type DiagnosticsResponse,
  type RefreshRun,
} from "../../../packages/contracts/src/index.ts";
import { useCallback, useEffect, useRef, useState } from "react";

const ZONE = "America/New_York";
const DIAGNOSTICS_URL = "/api/diagnostics?limit=12";

function formatObserved(instant: string | null) {
  if (!instant) return "Not observed";
  return DateTime.fromISO(instant)
    .setZone(ZONE)
    .toLocaleString({
      ...DateTime.DATETIME_MED_WITH_WEEKDAY,
      timeZoneName: "short",
    });
}

function formatAge(seconds: number | null) {
  if (seconds === null) return "No successful full collection yet";
  if (seconds < 60) return "less than a minute";
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `about ${Math.round(seconds / 3600)} hours`;
  return `about ${Math.round(seconds / 86400)} days`;
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} sec`;
}

function label(value: string) {
  return value.replaceAll("-", " ");
}

function DiagnosticSummary({
  diagnostic,
}: {
  diagnostic: ConnectorDiagnostic | null;
}) {
  if (!diagnostic)
    return (
      <p className="diagnostics-no-detail">No request diagnostic recorded.</p>
    );

  return (
    <p className="diagnostics-run-diagnostic">
      <strong>Request diagnostic:</strong> {label(diagnostic.stage)} stage ·{" "}
      {label(diagnostic.kind)}
      {diagnostic.endpoint ? ` · ${label(diagnostic.endpoint)}` : ""}
      {diagnostic.httpStatus ? ` · HTTP ${diagnostic.httpStatus}` : ""}
      {diagnostic.networkCode ? ` · ${diagnostic.networkCode}` : ""}
    </p>
  );
}

function RunCard({ run }: { run: RefreshRun }) {
  return (
    <article className="diagnostics-run-card">
      <div className="diagnostics-run-heading">
        <h4>{formatObserved(run.startedAt)}</h4>
        <span className={`diagnostics-outcome outcome-${run.outcome}`}>
          {label(run.outcome)}
        </span>
      </div>
      <p className="diagnostics-run-stats">
        {run.trigger === "diagnostic"
          ? "One-off diagnosis"
          : formatDuration(run.elapsedMs)}{" "}
        · {run.requests ?? "Unknown"}{" "}
        {run.requests === 1 ? "request" : "requests"} · {run.completedDates}/
        {run.requestedDates} dates complete
      </p>
      {run.errorCode && (
        <p className="diagnostics-run-error">
          {label(run.errorCode)}
          {run.message ? ` · ${run.message}` : ""}
        </p>
      )}
      <DiagnosticSummary diagnostic={run.diagnostic} />
    </article>
  );
}

export default function DiagnosticsPanel() {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const requestInFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<DiagnosticsResponse | null>(null);
  const [loadError, setLoadError] = useState(false);

  const loadDiagnostics = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      const result = await fetch(DIAGNOSTICS_URL);
      if (!result.ok) throw new Error("Diagnostics request failed");
      const parsed = DiagnosticsResponseSchema.parse(await result.json());
      setResponse(parsed);
      setLoadError(false);
    } catch {
      // Keep failures generic: do not expose server or schema-validation details.
      setLoadError(true);
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadDiagnostics();
    const timer = window.setInterval(() => void loadDiagnostics(), 15_000);
    const onFocus = () => void loadDiagnostics();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadDiagnostics, open]);

  const source = response?.source;
  const collection = response?.collection;
  const legacyChecks =
    response?.runs.length === 0 ? response.checks.slice(0, 3) : [];

  return (
    <details
      className="diagnostics-panel"
      ref={detailsRef}
      onToggle={() => setOpen(detailsRef.current?.open ?? false)}
    >
      <summary>Refresh activity &amp; diagnostics</summary>
      <div className="diagnostics-content">
        <p className="diagnostics-service-note">
          {loadError
            ? "Current service health could not be confirmed; any diagnostics below are previously retrieved data."
            : response
              ? "The local app service is responding; this is separate from McCarren collection freshness."
              : "Checking the local service; provider freshness is reported separately."}
        </p>
        {loading && !response && (
          <p className="diagnostics-loading" role="status">
            Loading cached refresh diagnostics…
          </p>
        )}
        {loadError && (
          <div className="diagnostics-error" role="alert">
            <p>
              Diagnostics could not be loaded. Check that the local app is
              running, then retry.
            </p>
            <button
              className="text-button"
              type="button"
              onClick={() => void loadDiagnostics()}
              disabled={loading}
            >
              {loading ? "Retrying…" : "Retry diagnostics"}
            </button>
          </div>
        )}
        {response && (
          <>
            <section
              className="diagnostics-health"
              aria-label="Collection health"
            >
              <div className="diagnostics-health-heading">
                <h3>Collection status</h3>
                <span
                  className={`diagnostics-collection-status collection-${collection!.status}`}
                >
                  {loadError
                    ? "Current status unknown"
                    : label(collection!.status)}
                </span>
              </div>
              <p>
                {loadError
                  ? "Current collection freshness is unknown because diagnostics could not be updated."
                  : collection!.status === "paused"
                    ? `Collection is paused locally; last full success was ${formatAge(collection!.lastSuccessAgeSeconds)} ago.`
                    : collection!.isFresh
                      ? `Collection is fresh; last full success was ${formatAge(collection!.lastSuccessAgeSeconds)} ago.`
                      : `Collection is not fresh (${label(collection!.status)}); last full success was ${formatAge(collection!.lastSuccessAgeSeconds)} ago.`}
              </p>
              <p>
                Source health: {label(source!.health)}. {source!.message}
              </p>
              <dl className="diagnostics-facts">
                <div>
                  <dt>Last full success</dt>
                  <dd>{formatObserved(source!.lastSuccessAt)}</dd>
                </div>
                <div>
                  <dt>Last collection attempt</dt>
                  <dd>{formatObserved(source!.lastAttemptAt)}</dd>
                </div>
                <div>
                  <dt>
                    {source!.collectionPaused
                      ? source!.providerNotBefore
                        ? "Recorded provider not-before"
                        : "Last scheduled due before pause"
                      : "Next due"}
                  </dt>
                  <dd>{formatObserved(source!.nextDueAt)}</dd>
                </div>
                <div>
                  <dt>Automatic cadence</dt>
                  <dd>
                    {source!.collectionPaused
                      ? "Paused locally"
                      : `${source!.cadenceSeconds} seconds while the service runs`}
                  </dd>
                </div>
                <div>
                  <dt>Freshness threshold</dt>
                  <dd>
                    {Math.round(collection!.staleAfterSeconds / 60)} minutes
                  </dd>
                </div>
              </dl>
              <DiagnosticSummary diagnostic={source!.lastDiagnostic ?? null} />
              {loading && (
                <p className="diagnostics-updating" aria-live="polite">
                  Updating cached diagnostics…
                </p>
              )}
            </section>

            <section
              className="diagnostics-history"
              aria-labelledby="diagnostics-runs-heading"
            >
              <div className="diagnostics-section-heading">
                <h3 id="diagnostics-runs-heading">Recent refresh runs</h3>
                <span>Latest {Math.min(response.runs.length, 12)}</span>
              </div>
              {response.runs.length > 0 ? (
                <div className="diagnostics-run-list">
                  {response.runs.slice(0, 12).map((run) => (
                    <RunCard key={run.id} run={run} />
                  ))}
                </div>
              ) : legacyChecks.length > 0 ? (
                <>
                  <p className="diagnostics-legacy-note">
                    Earlier history contains date checks only; detailed request
                    diagnostics were not recorded.
                  </p>
                  <ul className="diagnostics-legacy-list">
                    {legacyChecks.map((check) => (
                      <li key={`${check.localDate}-${check.checkedAt}`}>
                        <strong>{check.localDate}</strong> ·{" "}
                        {formatObserved(check.checkedAt)}
                        {check.errorCode
                          ? ` · ${label(check.errorCode)}`
                          : " · complete"}
                        {check.message ? ` · ${check.message}` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="diagnostics-no-detail">
                  No refresh run or earlier date-check history is recorded.
                </p>
              )}
            </section>
            <p className="diagnostics-logs-hint">
              For service logs, run{" "}
              <code>docker compose logs --timestamps --follow</code>.
            </p>
          </>
        )}
      </div>
    </details>
  );
}
