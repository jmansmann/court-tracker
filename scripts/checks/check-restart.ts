import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  PreferencesSchema,
  ScheduleResponseSchema,
  type ScheduleResponse,
  type PartitionView,
} from "../../packages/contracts/src/index.ts";

const base = "http://127.0.0.1:4317";
const savedPreferences = PreferencesSchema.parse(
  await (await fetch(`${base}/api/preferences`)).json(),
);
const before = ScheduleResponseSchema.parse(
  await (await fetch(`${base}/api/schedule`)).json(),
);
const temporaryPreferences = {
  ...savedPreferences,
  view: "day" as const,
  durationMinutes: 90 as const,
  includeUnknownDuration: false,
};
try {
  const update = await fetch(`${base}/api/preferences`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(temporaryPreferences),
  });
  assert.equal(update.ok, true);
  execFileSync("docker", ["compose", "restart"], { stdio: "inherit" });
  const deadline = Date.now() + 30000;
  let after: ScheduleResponse | undefined;
  while (Date.now() < deadline) {
    try {
      after = ScheduleResponseSchema.parse(
        await (await fetch(`${base}/api/schedule`)).json(),
      );
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  assert.ok(after);
  assert.deepEqual(after.preferences, temporaryPreferences);
  for (const partition of before.partitions) {
    const restored: PartitionView | undefined = after.partitions.find(
      (row) => row.localDate === partition.localDate,
    );
    assert.equal(restored?.coverage, partition.coverage);
    assert.ok(
      restored?.lastSuccessAt &&
        partition.lastSuccessAt &&
        restored.lastSuccessAt >= partition.lastSuccessAt,
    );
    assert.deepEqual(
      restored.openings.map((opening) => opening.id),
      partition.openings.map((opening) => opening.id),
    );
  }
  console.log(
    JSON.stringify({
      state: "restart-persistence-verified",
      partitions: after.partitions.length,
      preservedOpenings: after.partitions.reduce(
        (count, partition) => count + partition.openings.length,
        0,
      ),
      preferencesRestored: true,
    }),
  );
} finally {
  await fetch(`${base}/api/preferences`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(savedPreferences),
  });
}
