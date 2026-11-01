import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { createPrivateStore, resolveProjectRoot } from "./local-state.ts";

describe("private local JSON state", () => {
  let root: string;
  let store: ReturnType<typeof createPrivateStore>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tennis-local-state-"));
    store = createPrivateStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips JSON and creates private directories and files", async () => {
    const value = { token: "not-logged", nested: [1, true, null] };
    await store.writePrivateJson("session-state.json", value);

    assert.deepEqual(await store.readPrivateJson("session-state.json"), value);

    const localMode = (await stat(join(root, ".local"))).mode & 0o777;
    const storageMode =
      (await stat(join(root, ".local", "mccarren"))).mode & 0o777;
    const fileMode =
      (await stat(join(root, ".local", "mccarren", "session-state.json")))
        .mode & 0o777;
    assert.equal(localMode, 0o700);
    assert.equal(storageMode, 0o700);
    assert.equal(fileMode, 0o600);
  });

  it("tightens pre-existing storage directories before writing", async () => {
    await mkdir(join(root, ".local", "mccarren"), {
      recursive: true,
      mode: 0o755,
    });
    await chmod(join(root, ".local"), 0o755);
    await chmod(join(root, ".local", "mccarren"), 0o755);

    await store.writePrivateJson("state.json", { safe: true });

    assert.equal((await stat(join(root, ".local"))).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(root, ".local", "mccarren"))).mode & 0o777,
      0o700,
    );
  });

  it("returns undefined for missing state without creating storage", async () => {
    assert.equal(await store.readPrivateJson("session-state.json"), undefined);
  });

  it("resolves the same package root from source and compiled module URLs", async () => {
    await writeFile(join(root, "package.json"), "{}", { mode: 0o600 });
    const sourceModule = pathToFileURL(
      join(root, "apps", "service", "src", "local-state.ts"),
    );
    const compiledModule = pathToFileURL(
      join(root, "dist", "apps", "service", "src", "local-state.js"),
    );

    assert.equal(resolveProjectRoot(sourceModule), root);
    assert.equal(resolveProjectRoot(compiledModule), root);
  });

  it("rejects path-like or nonconforming names", async () => {
    for (const name of [
      "../secret.json",
      ".secret.json",
      "A.json",
      "a/b.json",
      "a.json.bak",
    ]) {
      await assert.rejects(
        store.writePrivateJson(name, {}),
        /Invalid private state filename/,
      );
      await assert.rejects(
        store.readPrivateJson(name),
        /Invalid private state filename/,
      );
    }
  });

  it("refuses symlinks in the root, storage directories, and destination", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);

    const rootAlias = join(root, "root-link");
    await symlink(elsewhere, rootAlias);
    await assert.rejects(
      createPrivateStore(rootAlias).writePrivateJson("state.json", {}),
      /Unsafe private state root/,
    );
    await assert.rejects(
      createPrivateStore(rootAlias).readPrivateJson("state.json"),
      /Unsafe private state root/,
    );

    const localAliasRoot = join(root, "local-alias-root");
    await mkdir(localAliasRoot);
    await symlink(elsewhere, join(localAliasRoot, ".local"));
    await assert.rejects(
      createPrivateStore(localAliasRoot).writePrivateJson("state.json", {}),
      /Unsafe private state directory/,
    );
    await assert.rejects(
      createPrivateStore(localAliasRoot).readPrivateJson("state.json"),
      /Unsafe private state directory/,
    );

    const storageAliasRoot = join(root, "storage-alias-root");
    await mkdir(join(storageAliasRoot, ".local"), { recursive: true });
    await symlink(elsewhere, join(storageAliasRoot, ".local", "mccarren"));
    await assert.rejects(
      createPrivateStore(storageAliasRoot).writePrivateJson("state.json", {}),
      /Unsafe private state directory/,
    );
    await assert.rejects(
      createPrivateStore(storageAliasRoot).readPrivateJson("state.json"),
      /Unsafe private state directory/,
    );

    await store.writePrivateJson("target.json", { value: true });
    const destination = join(root, ".local", "mccarren", "linked.json");
    await symlink(join(root, ".local", "mccarren", "target.json"), destination);
    await assert.rejects(
      store.readPrivateJson("linked.json"),
      /Unsafe private state file/,
    );
    await assert.rejects(
      store.writePrivateJson("linked.json", { changed: true }),
      /Unsafe private state file/,
    );
  });

  it("rejects malformed JSON with an error that does not expose its path", async () => {
    const directory = join(root, ".local", "mccarren");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "broken.json"), "{not-json", {
      mode: 0o600,
    });

    await assert.rejects(
      store.readPrivateJson("broken.json"),
      (error: Error) => {
        assert.equal(error.message, "Invalid private state JSON");
        assert.equal(error.message.includes(root), false);
        return true;
      },
    );
  });

  it("rejects oversized and broadly-readable files", async () => {
    const directory = join(root, ".local", "mccarren");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const oversized = join(directory, "large.json");
    await writeFile(oversized, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20), {
      mode: 0o600,
    });
    await assert.rejects(
      store.readPrivateJson("large.json"),
      /exceeds size limit/,
    );

    const exposed = join(directory, "exposed.json");
    await writeFile(exposed, "{}", { mode: 0o644 });
    await chmod(exposed, 0o644);
    await assert.rejects(
      store.readPrivateJson("exposed.json"),
      /Unsafe private state file permissions/,
    );
  });

  it("does not leave a destination for a non-serializable value", async () => {
    await assert.rejects(
      store.writePrivateJson("invalid.json", undefined),
      /not JSON-serializable/,
    );
    assert.equal(await store.readPrivateJson("invalid.json"), undefined);
  });
});
