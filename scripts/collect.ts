import { McCarrenConnector } from "../apps/service/src/connectors/mccarren.ts";
import {
  localToday,
  PartitionResultSchema,
  type PartitionResult,
} from "../packages/contracts/src/index.ts";
import { writePrivateJson } from "../apps/service/src/local-state.ts";
import {
  providerReadPermission,
  persistObservedRateLimit,
} from "../apps/service/src/provider-access.ts";

const permission = providerReadPermission();
if (!permission.allowed) {
  console.error(permission.message);
  process.exit(2);
}

const connector = new McCarrenConnector({
  headless: process.argv.includes("--headless"),
});
try {
  const partitions: PartitionResult[] = [];
  let rateLimitRecorded = false;
  const summary = await connector.collect({
    from: localToday(),
    days: 8,
    onPartition: (partition) => {
      if (
        !rateLimitRecorded &&
        partition.state === "failed" &&
        partition.errorCode === "rate-limited"
      ) {
        persistObservedRateLimit({
          observedAt: partition.checkedAt,
          retryAfterSeconds: partition.retryAfterSeconds,
          diagnostic: partition.diagnostic,
        });
        rateLimitRecorded = true;
      }
      partitions.push(PartitionResultSchema.parse(partition));
    },
  });
  if (!rateLimitRecorded && summary.terminalError === "rate-limited")
    persistObservedRateLimit({
      observedAt: new Date().toISOString(),
      retryAfterSeconds: summary.retryAfterSeconds,
      diagnostic: summary.diagnostic,
      requests: summary.requests,
    });
  const report = {
    observedAt: new Date().toISOString(),
    summary,
    metrics: connector.lastRunMetrics,
    partitions,
  };
  if (!summary.terminalError && summary.completedDates === 8)
    await writePrivateJson("full-result.json", report);
  console.log(
    JSON.stringify(
      {
        observedAt: report.observedAt,
        summary,
        metrics: report.metrics,
        partitions: partitions.map((partition) =>
          partition.state === "complete"
            ? {
                date: partition.localDate,
                state: partition.state,
                openings: partition.openings.length,
              }
            : {
                date: partition.localDate,
                state: partition.state,
                errorCode: partition.errorCode,
                message: partition.message,
              },
        ),
      },
      null,
      2,
    ),
  );
  if (summary.terminalError || summary.completedDates !== 8)
    process.exitCode = 1;
} finally {
  await connector.close();
}
