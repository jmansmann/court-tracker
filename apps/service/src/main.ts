import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import { resolveProjectRoot } from "./local-state.ts";
import { localToday } from "../../../packages/contracts/src/index.ts";
import { McCarrenConnector } from "./connectors/mccarren.ts";
import { ScheduleStore } from "./store.ts";
import { RefreshScheduler } from "./scheduler.ts";
import { buildApp } from "./http.ts";

process.umask(0o077);
const root = resolveProjectRoot(import.meta.url);
const local = join(root, ".local");
const databasePath = join(local, "schedule.sqlite");
const port = Number(process.env.PORT ?? "4317");
const cadenceSeconds = Number(process.env.REFRESH_SECONDS ?? "900");
const collectionEnabled = process.env.COLLECTION_ENABLED === "true";
const host = process.env.CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1";
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !Number.isInteger(cadenceSeconds) ||
  cadenceSeconds < 900 ||
  cadenceSeconds > 3600 ||
  ![undefined, "true", "false"].includes(process.env.COLLECTION_ENABLED) ||
  ![undefined, "true", "false"].includes(process.env.HEADLESS)
) {
  throw new Error("Invalid local service configuration");
}
try {
  await mkdir(local, { mode: 0o700 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST")
    throw new Error("Unable to create local storage");
}
const directory = await lstat(local);
if (!directory.isDirectory() || directory.isSymbolicLink())
  throw new Error("Unsafe local storage directory");
const directoryHandle = await open(
  local,
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
);
await directoryHandle.chmod(0o700);
await directoryHandle.close();
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    const entry = await lstat(databasePath + suffix);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("Unsafe schedule storage");
    await chmod(databasePath + suffix, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Unsafe schedule storage");
  }
}
const store = new ScheduleStore(databasePath);
store.prune(localToday(), DateTime.utc().minus({ days: 7 }).toISO()!);
const connector = new McCarrenConnector({
  headless: process.env.HEADLESS === "true",
});
const scheduler = new RefreshScheduler({
  store,
  connector,
  collectionEnabled,
  cadenceSeconds,
  onEvent: (event) => console.log(JSON.stringify(event)),
  sessionRevision: async () => {
    try {
      const session = await lstat(join(local, "mccarren", "session.json"));
      if (
        !session.isFile() ||
        session.isSymbolicLink() ||
        (session.mode & 0o777) !== 0o600
      )
        return null;
      return `${session.mtimeMs}:${session.size}`;
    } catch {
      return null;
    }
  },
});
const app = await buildApp({
  store,
  scheduler,
  port,
  webRoot: join(root, "dist", "web"),
  architectureHtml: join(root, "docs", "architecture.html"),
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log(
    JSON.stringify({ at: new Date().toISOString(), event: "service.stopping" }),
  );
  await app.close();
};
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
await app.listen({ host, port });
scheduler.start();
console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    event: "service.started",
    url: `http://127.0.0.1:${port}`,
    collectionEnabled,
    cadenceSeconds,
    collectionHealth: scheduler.status().health,
    nextDueAt: scheduler.status().nextDueAt,
  }),
);
