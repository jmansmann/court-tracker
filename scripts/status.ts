import { DiagnosticsResponseSchema } from "../packages/contracts/src/index.ts";

try {
  const response = await fetch(
    "http://127.0.0.1:4317/api/diagnostics?limit=12",
    { signal: AbortSignal.timeout(5000) },
  );
  if (!response.ok) throw new Error("unavailable");
  const data = DiagnosticsResponseSchema.parse(await response.json());
  console.log(
    JSON.stringify(
      process.argv.includes("--history")
        ? data
        : {
            localService: "running",
            collection: data.collection,
            source: data.source,
            latestRun: data.runs[0] ?? null,
            latestDateCheck: data.checks[0] ?? null,
            note: data.runs.length
              ? "Use --history or the dashboard diagnostics panel for more history."
              : "Earlier runs have date-check history only; request-level diagnostics were not recorded.",
          },
      null,
      2,
    ),
  );
  if (!data.collection.isFresh) process.exitCode = 2;
} catch {
  console.error(
    "Local diagnostics are unavailable. Check docker compose ps and docker compose logs --timestamps.",
  );
  process.exitCode = 1;
}
