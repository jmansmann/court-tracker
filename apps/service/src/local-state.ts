import { randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PRIVATE_NAME = /^[a-z][a-z0-9-]*\.json$/;
const NOFOLLOW = constants.O_NOFOLLOW;
const DIRECTORY = constants.O_DIRECTORY;

class PrivateStateError extends Error {}

function assertName(name: string): void {
  if (typeof name !== "string" || !PRIVATE_NAME.test(name)) {
    throw new PrivateStateError("Invalid private state filename");
  }
}

function hasMode(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function checkDirectory(
  directoryPath: string,
  create: boolean,
  tighten: boolean,
): Promise<boolean> {
  try {
    await lstat(directoryPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      if (!create) return false;
      try {
        await mkdir(directoryPath, { mode: DIRECTORY_MODE });
      } catch (mkdirError) {
        if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
      }
    } else {
      throw error;
    }
  }

  const entry = await lstat(directoryPath);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new PrivateStateError("Unsafe private state directory");
  }

  const handle = await open(
    directoryPath,
    constants.O_RDONLY | DIRECTORY | NOFOLLOW,
  );
  try {
    let stats = await handle.stat();
    if (!stats.isDirectory()) {
      throw new PrivateStateError("Unsafe private state directory");
    }
    if (tighten && (stats.mode & 0o777) !== DIRECTORY_MODE) {
      await handle.chmod(DIRECTORY_MODE);
      stats = await handle.stat();
    }
    if (!hasMode(stats.mode, DIRECTORY_MODE)) {
      throw new PrivateStateError("Unsafe private state directory permissions");
    }
  } finally {
    await handle.close();
  }
  return true;
}

async function checkRoot(rootPath: string): Promise<void> {
  const root = await lstat(rootPath);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new PrivateStateError("Unsafe private state root");
  }
}

async function inspectDestination(filePath: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new PrivateStateError("Unsafe private state file");
  }
}

export interface PrivateStore {
  writePrivateJson(name: string, value: unknown): Promise<void>;
  readPrivateJson(name: string): Promise<unknown | undefined>;
}

/**
 * Walk upward from the caller's module URL to the nearest directory with a
 * package.json. This works across the app, package, and script source trees
 * and their `dist/` builds without depending on the process working directory.
 */
export function resolveProjectRoot(moduleUrl: string | URL): string {
  let directory: string;
  try {
    directory = dirname(fileURLToPath(moduleUrl));
  } catch {
    throw new Error("Unable to resolve project root");
  }

  while (true) {
    try {
      if (lstatSync(join(directory, "package.json")).isFile()) {
        return directory;
      }
    } catch {
      // Keep walking; the first package marker above this module owns the root.
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error("Unable to resolve project root");
}

/** Create a private JSON store beneath `<root>/.local/mccarren`. */
export function createPrivateStore(root: string): PrivateStore {
  const rootPath = resolve(root);
  const localPath = join(rootPath, ".local");
  const storagePath = join(localPath, "mccarren");

  async function prepareStorage(): Promise<void> {
    await checkRoot(rootPath);
    await checkDirectory(localPath, true, true);
    await checkDirectory(storagePath, true, true);
  }

  async function locateStorageForRead(): Promise<boolean> {
    try {
      await checkRoot(rootPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
    if (!(await checkDirectory(localPath, false, false))) return false;
    return checkDirectory(storagePath, false, false);
  }

  return {
    async writePrivateJson(name, value): Promise<void> {
      assertName(name);
      let temporaryPath: string | undefined;
      try {
        await prepareStorage();
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
          throw new PrivateStateError(
            "Private state value is not JSON-serializable",
          );
        }
        const contents = Buffer.from(serialized, "utf8");
        if (contents.byteLength > MAX_FILE_BYTES) {
          throw new PrivateStateError("Private state file exceeds size limit");
        }

        const destinationPath = join(storagePath, name);
        await inspectDestination(destinationPath);
        temporaryPath = join(storagePath, `.${name}.${randomUUID()}.tmp`);
        const handle = await open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
          FILE_MODE,
        );
        try {
          await handle.chmod(FILE_MODE);
          await handle.writeFile(contents);
        } finally {
          await handle.close();
        }

        await inspectDestination(destinationPath);
        await rename(temporaryPath, destinationPath);
      } catch (error) {
        if (error instanceof PrivateStateError) throw error;
        throw new PrivateStateError("Unable to write private state");
      } finally {
        if (temporaryPath !== undefined) {
          try {
            await unlink(temporaryPath);
          } catch {
            // The successful rename already consumed this operation's temp file.
          }
        }
      }
    },

    async readPrivateJson(name): Promise<unknown | undefined> {
      assertName(name);
      try {
        if (!(await locateStorageForRead())) return undefined;
        const filePath = join(storagePath, name);
        let entry;
        try {
          entry = await lstat(filePath);
        } catch (error) {
          if (isErrno(error, "ENOENT")) return undefined;
          throw error;
        }
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw new PrivateStateError("Unsafe private state file");
        }
        if (!hasMode(entry.mode, FILE_MODE)) {
          throw new PrivateStateError("Unsafe private state file permissions");
        }

        const handle = await open(filePath, constants.O_RDONLY | NOFOLLOW);
        let contents: Buffer;
        try {
          const stats = await handle.stat();
          if (
            !stats.isFile() ||
            stats.dev !== entry.dev ||
            stats.ino !== entry.ino ||
            !hasMode(stats.mode, FILE_MODE)
          ) {
            throw new PrivateStateError("Unsafe private state file");
          }
          if (stats.size > MAX_FILE_BYTES) {
            throw new PrivateStateError(
              "Private state file exceeds size limit",
            );
          }

          const boundedContents = Buffer.alloc(MAX_FILE_BYTES + 1);
          let bytesRead = 0;
          while (bytesRead < boundedContents.length) {
            const result = await handle.read(
              boundedContents,
              bytesRead,
              boundedContents.length - bytesRead,
              null,
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
          }
          if (bytesRead > MAX_FILE_BYTES) {
            throw new PrivateStateError(
              "Private state file exceeds size limit",
            );
          }
          contents = boundedContents.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }

        try {
          return JSON.parse(contents.toString("utf8")) as unknown;
        } catch {
          throw new PrivateStateError("Invalid private state JSON");
        }
      } catch (error) {
        if (error instanceof PrivateStateError) throw error;
        throw new PrivateStateError("Unable to read private state");
      }
    },
  };
}

const projectRoot = resolveProjectRoot(import.meta.url);
const productionStore = createPrivateStore(projectRoot);

export function writePrivateJson(name: string, value: unknown): Promise<void> {
  return productionStore.writePrivateJson(name, value);
}

export function readPrivateJson(name: string): Promise<unknown | undefined> {
  return productionStore.readPrivateJson(name);
}
