/**
 * Tests for Loop v2 cache directory & symlink utilities.
 *
 * These tests validate the external behavior of the cache module:
 * path resolution, directory creation, and junction creation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Cache directory resolution
// ---------------------------------------------------------------------------

describe("getLoopDataDir", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.LOOP_DATA_DIR;
  });

  it("uses LOOP_DATA_DIR env var when set", async () => {
    const { getLoopDataDir } = await import("./cache.ts");
    process.env.LOOP_DATA_DIR = "D:\\Custom\\Loop";
    expect(getLoopDataDir()).toBe(
      path.resolve("D:\\Custom\\Loop"),
    );
  });

  it("ignores LOOP_DATA_DIR when set to empty string", async () => {
    const { getLoopDataDir } = await import("./cache.ts");
    process.env.LOOP_DATA_DIR = "  ";
    // Falls through to platform default
    const result = getLoopDataDir();
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty path when no env var is set", async () => {
    const { getLoopDataDir } = await import("./cache.ts");
    delete process.env.LOOP_DATA_DIR;
    const result = getLoopDataDir();
    expect(result).toBeTruthy();
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("returns an absolute path", async () => {
    const { getLoopDataDir } = await import("./cache.ts");
    delete process.env.LOOP_DATA_DIR;
    const result = getLoopDataDir();
    expect(path.isAbsolute(result)).toBe(true);
  });
});

describe("getBeadsDbPath / getSandcastlePath / getLogsPath", () => {
  it("returns correct subdirectory paths", async () => {
    const { getBeadsDbPath, getSandcastlePath, getLogsPath } = await import(
      "./cache.ts"
    );
    const base = "C:\\TestData\\Loop";
    expect(getBeadsDbPath(base)).toBe(path.resolve(base, "beads"));
    expect(getSandcastlePath(base)).toBe(path.resolve(base, "sandcastle"));
    expect(getLogsPath(base)).toBe(path.resolve(base, "logs"));
  });

  it("uses default data dir when not provided", async () => {
    const { getBeadsDbPath, getLoopDataDir } = await import("./cache.ts");
    // getLoopDataDir reads env vars, so ensure a known default
    process.env.LOOP_DATA_DIR = "C:\\TestDefault\\Loop";
    try {
      const dataDir = getLoopDataDir();
      expect(getBeadsDbPath()).toBe(path.resolve(dataDir, "beads"));
    } finally {
      delete process.env.LOOP_DATA_DIR;
    }
  });
});

// ---------------------------------------------------------------------------
// ensureCacheDirs
// ---------------------------------------------------------------------------

describe("ensureCacheDirs", () => {
  const tmpDir = path.resolve(os.tmpdir(), "loop-test-cache-" + Date.now());

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates all subdirectories under the given root", async () => {
    const { ensureCacheDirs } = await import("./cache.ts");
    const root = ensureCacheDirs(tmpDir);

    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(path.resolve(root, "beads"))).toBe(true);
    expect(fs.existsSync(path.resolve(root, "sandcastle"))).toBe(true);
    expect(fs.existsSync(path.resolve(root, "logs"))).toBe(true);
    expect(fs.existsSync(path.resolve(root, "node_modules"))).toBe(true);
  });

  it("creates missing parent directories", async () => {
    const { ensureCacheDirs } = await import("./cache.ts");
    const deepDir = path.resolve(tmpDir, "a", "b", "c");
    const root = ensureCacheDirs(deepDir);
    expect(fs.statSync(root).isDirectory()).toBe(true);
  });

  it("is idempotent when directories already exist", async () => {
    const { ensureCacheDirs } = await import("./cache.ts");
    // First call creates
    ensureCacheDirs(tmpDir);
    // Second call should not throw
    expect(() => ensureCacheDirs(tmpDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Junction / Symlink utilities
// ---------------------------------------------------------------------------

describe("createJunction", () => {
  const tmpDir = path.resolve(os.tmpdir(), "loop-test-junction-" + Date.now());

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a junction pointing to the target directory", async () => {
    const { createJunction } = await import("./cache.ts");

    const target = path.resolve(tmpDir, "target");
    const link = path.resolve(tmpDir, "link");
    fs.mkdirSync(target, { recursive: true });

    // Create a file in target to verify the link works
    fs.writeFileSync(path.resolve(target, "test.txt"), "hello");

    createJunction(link, target);

    expect(fs.existsSync(link)).toBe(true);
    expect(fs.existsSync(path.resolve(link, "test.txt"))).toBe(true);
    expect(fs.readFileSync(path.resolve(link, "test.txt"), "utf-8")).toBe(
      "hello",
    );
  });

  it("throws when target does not exist", async () => {
    const { createJunction } = await import("./cache.ts");
    const missing = path.resolve(tmpDir, "nonexistent");
    const link = path.resolve(tmpDir, "link");

    expect(() => createJunction(link, missing)).toThrow(/does not exist/);
  });

  it("is idempotent when link already points to the same target", async () => {
    const { createJunction } = await import("./cache.ts");

    const target = path.resolve(tmpDir, "target");
    const link = path.resolve(tmpDir, "link");
    fs.mkdirSync(target, { recursive: true });

    createJunction(link, target); // first creation
    expect(() => createJunction(link, target)).not.toThrow(); // idempotent
  });

  it("replaces an existing stale junction", async () => {
    const { createJunction } = await import("./cache.ts");

    const oldTarget = path.resolve(tmpDir, "old-target");
    const newTarget = path.resolve(tmpDir, "new-target");
    const link = path.resolve(tmpDir, "link");

    fs.mkdirSync(oldTarget, { recursive: true });
    fs.mkdirSync(newTarget, { recursive: true });

    createJunction(link, oldTarget);
    expect(fs.existsSync(link)).toBe(true);

    // Replace with new target
    createJunction(link, newTarget);
    expect(fs.existsSync(link)).toBe(true);
  });
});

describe("setupWorktreeSymlinks", () => {
  const tmpDir = path.resolve(
    os.tmpdir(),
    "loop-test-worktree-" + Date.now(),
  );
  const worktreeDir = path.resolve(tmpDir, "worktree");

  beforeEach(() => {
    fs.mkdirSync(worktreeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates junctions for symlinkPaths inside the worktree", async () => {
    const { setupWorktreeSymlinks, createJunction } = await import(
      "./cache.ts"
    );

    // createJunction is used internally; we test the full flow
    const dataDir = path.resolve(tmpDir, "data");
    fs.mkdirSync(path.resolve(dataDir, "node_modules"), { recursive: true });

    setupWorktreeSymlinks(worktreeDir, {
      symlinkPaths: ["node_modules"],
      copyPaths: [],
    }, dataDir);

    const junctionPath = path.resolve(worktreeDir, "node_modules");
    expect(fs.existsSync(junctionPath)).toBe(true);
    // Writing to the junction should reflect in the cache
    fs.writeFileSync(path.resolve(junctionPath, "shared.txt"), "shared");
    expect(
      fs.existsSync(path.resolve(dataDir, "node_modules", "shared.txt")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SymlinkConfig
// ---------------------------------------------------------------------------

describe("defaultSymlinkConfig", () => {
  it("includes node_modules and .sandcastle in symlinkPaths", async () => {
    const { defaultSymlinkConfig } = await import("./cache.ts");
    const config = defaultSymlinkConfig();
    expect(config.symlinkPaths).toContain("node_modules");
    expect(config.symlinkPaths).toContain(".sandcastle");
  });
});

describe("supportsJunctions", () => {
  it("returns boolean", async () => {
    const { supportsJunctions } = await import("./cache.ts");
    const result = supportsJunctions();
    expect(typeof result).toBe("boolean");
  });
});
