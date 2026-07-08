/**
 * Loop v2 - Cache Directory & Symlink Utilities
 *
 * Manages runtime data directory isolation: all runtime artifacts
 * (beads database, worktrees, logs, node_modules cache) live under
 * a user-local data directory instead of polluting the project root.
 *
 * LOOP_DATA_DIR env var controls the root; defaults to
 * %LOCALAPPDATA%/Loop/ on Windows, ~/.local/share/Loop/ on POSIX.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Cache Directory Resolution
// ---------------------------------------------------------------------------

/**
 * Subdirectory names under LOOP_DATA_DIR.
 *
 * Layout:
 *   <root>/
 *     beads/            — beads Dolt database
 *     sandcastle/
 *       worktrees/      — git worktrees (via junction at .sandcastle/worktrees)
 *       logs/           — agent session logs (via junction at .sandcastle/logs)
 *     node_modules/      — shared npm cache (via junction in worktrees)
 */
export const SUBDIRS = {
  beads: "beads",
  sandcastleWorktrees: ["sandcastle", "worktrees"],
  sandcastleLogs: ["sandcastle", "logs"],
  nodeModules: "node_modules",
} as const;

/**
 * Resolve the root loop data directory.
 *
 * Order of precedence:
 * 1. LOOP_DATA_DIR environment variable
 * 2. Windows: %LOCALAPPDATA%/Loop/
 * 3. POSIX:   $HOME/.local/share/Loop/
 */
export function getLoopDataDir(): string {
  const env = process.env.LOOP_DATA_DIR;
  if (env && env.trim().length > 0) {
    return path.resolve(env.trim());
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return path.resolve(localAppData, "Loop");
    }
    // Fallback: use USERPROFILE
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      return path.resolve(userProfile, "AppData", "Local", "Loop");
    }
  }

  // POSIX fallback
  const home = process.env.HOME;
  if (home) {
    return path.resolve(home, ".local", "share", "Loop");
  }

  // Ultimate fallback: temp directory
  return path.resolve(os.tmpdir(), ".loop-data");
}

/** Path to the beads database directory. */
export function getBeadsDbPath(dataDir?: string): string {
  return path.resolve(dataDir ?? getLoopDataDir(), SUBDIRS.beads);
}

/** Path to the sandcastle worktrees directory. */
export function getSandcastlePath(dataDir?: string): string {
  return path.resolve(dataDir ?? getLoopDataDir(), "sandcastle");
}

/** Path to sandcastle worktrees subdirectory. */
export function getSandcastleWorktreesPath(dataDir?: string): string {
  return path.resolve(dataDir ?? getLoopDataDir(), ...SUBDIRS.sandcastleWorktrees);
}

/** Path to sandcastle logs subdirectory. */
export function getSandcastleLogsPath(dataDir?: string): string {
  return path.resolve(dataDir ?? getLoopDataDir(), ...SUBDIRS.sandcastleLogs);
}

/** Path to the shared node_modules cache directory. */
export function getNodeModulesCachePath(dataDir?: string): string {
  return path.resolve(dataDir ?? getLoopDataDir(), SUBDIRS.nodeModules);
}

/**
 * Ensure all cache subdirectories exist, creating them as needed.
 * Returns the data dir root.
 */
export function ensureCacheDirs(dataDir?: string): string {
  const root = dataDir ?? getLoopDataDir();

  // beads (single-level)
  fs.mkdirSync(path.resolve(root, SUBDIRS.beads), { recursive: true });

  // sandcastle/worktrees and sandcastle/logs (nested)
  for (const segments of [SUBDIRS.sandcastleWorktrees, SUBDIRS.sandcastleLogs]) {
    fs.mkdirSync(path.resolve(root, ...segments), { recursive: true });
  }

  // node_modules cache
  fs.mkdirSync(path.resolve(root, SUBDIRS.nodeModules), { recursive: true });

  return root;
}

// ---------------------------------------------------------------------------
// Windows Junction (Symlink) Utilities
// ---------------------------------------------------------------------------

/**
 * Determine if the current platform supports directory junctions.
 * Windows: yes (mklink /J). POSIX: no (uses symlinks natively or just copy).
 */
export function supportsJunctions(): boolean {
  return process.platform === "win32";
}

/**
 * Create a Windows Junction (mklink /J) from `linkPath` to `targetPath`.
 *
 * - targetPath must exist.
 * - linkPath must NOT exist (will fail if it does).
 * - Requires Windows, no admin needed for junctions.
 *
 * On POSIX platforms, this falls back to a symlink.
 */
export function createJunction(linkPath: string, targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Junction target does not exist: ${targetPath}`);
  }

  if (fs.existsSync(linkPath)) {
    // If it already exists as a junction/symlink to the same target, skip.
    try {
      const real = fs.realpathSync(linkPath);
      if (real === fs.realpathSync(targetPath)) {
        return;
      }
    } catch {
      // realpath may fail on broken junctions; remove and recreate
    }
    // Remove the existing link so we can recreate it
    fs.rmSync(linkPath, { recursive: true, force: true });
  }

  if (process.platform === "win32") {
    // Ensure parent directory exists
    const parent = path.dirname(linkPath);
    fs.mkdirSync(parent, { recursive: true });

    // mklink /J requires the link name WITHOUT trailing backslash
    const link = linkPath.replace(/[/\\]+$/, "");
    const target = targetPath.replace(/[/\\]+$/, "");
    execSync(`cmd /c mklink /J "${link}" "${target}"`, {
      stdio: "pipe",
      timeout: 10_000,
    });
  } else {
    // POSIX: standard symlink
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(targetPath, linkPath, "dir");
  }
}

/**
 * Configuration for the symlink/copy split in sandbox worktree creation.
 *
 * Paths in `symlinkPaths` will be created as junctions/symlinks pointing to
 * a shared cache under LOOP_DATA_DIR.
 *
 * Paths in `copyPaths` will be copied normally into the worktree.
 */
export interface SymlinkConfig {
  /** Relative paths (from project root) to create as symlinks/junctions. */
  symlinkPaths: string[];
  /** Relative paths (from project root) to copy normally. */
  copyPaths: string[];
}

/**
 * Default symlink configuration for Loop projects.
 *
 * - node_modules → shared cache via Junction (gitignored, large, infrequently changed)
 * Everything else copies normally (sandcastle prompts are in git, worktree already has them).
 */
export function defaultSymlinkConfig(): SymlinkConfig {
  return {
    symlinkPaths: ["node_modules"],
    copyPaths: [
      // Default paths that should always be copied:
      // (empty — everything not in symlinkPaths is a copy)
    ],
  };
}

/**
 * Create junctions/symlinks inside a worktree for the configured paths.
 *
 * Currently supports node_modules (the only gitignored large directory
 * that benefits from sharing across worktrees).
 *
 * @param worktreeDir - Absolute path to the worktree root
 * @param config - Symlink configuration
 * @param dataDir - LOOP_DATA_DIR (resolved automatically if omitted)
 */
export function setupWorktreeSymlinks(
  worktreeDir: string,
  config: SymlinkConfig,
  dataDir?: string,
): void {
  const cacheRoot = dataDir ?? getLoopDataDir();

  for (const relPath of config.symlinkPaths) {
    const linkTarget = path.resolve(worktreeDir, relPath);
    const cacheSource = path.resolve(cacheRoot, SUBDIRS.nodeModules);

    // All symlinkPaths point to the shared node_modules cache.
    // (Only node_modules is gitignored and benefits from caching.)
    const source = cacheSource;

    // Ensure cache source exists
    fs.mkdirSync(cacheSource, { recursive: true });

    createJunction(linkTarget, source);
  }
}

// ---------------------------------------------------------------------------
// Sandcastle Directory Junctions
//
// Redirect sandcastle's hardcoded .sandcastle/worktrees/ and .sandcastle/logs/
// directories to LOOP_DATA_DIR/sandcastle/worktrees/ and
// LOOP_DATA_DIR/sandcastle/logs/ via junctions.
// ---------------------------------------------------------------------------

/**
 * Relative paths (from project root) that sandcastle uses for worktrees and
 * logs, which we redirect via junctions.
 */
const SANDCASTLE_REL_DIRS = {
  worktrees: [".sandcastle", "worktrees"],
  logs: [".sandcastle", "logs"],
} as const;

/**
 * Set up junctions so that sandcastle's hardcoded paths
 * (.sandcastle/worktrees, .sandcastle/logs) transparently point to
 * LOOP_DATA_DIR/sandcastle/{worktrees,logs}/.
 *
 * Must be called once at startup, before any sandcastle operation.
 * Idempotent: safe to call multiple times.
 */
export function setupSandcastleDirJunctions(dataDir?: string): void {
  const root = dataDir ?? getLoopDataDir();

  // Ensure backend directories exist
  const backendWorktrees = path.resolve(root, ...SUBDIRS.sandcastleWorktrees);
  const backendLogs = path.resolve(root, ...SUBDIRS.sandcastleLogs);
  fs.mkdirSync(backendWorktrees, { recursive: true });
  fs.mkdirSync(backendLogs, { recursive: true });

  // Create junctions from .sandcastle/{worktrees,logs} -> LOOP_DATA_DIR/sandcastle/{worktrees,logs}
  for (const [key, segments] of Object.entries(SANDCASTLE_REL_DIRS)) {
    const junctionPath = path.resolve(process.cwd(), ...segments);
    const targetPath = path.resolve(
      root,
      "sandcastle",
      key as "worktrees" | "logs",
    );
    createJunction(junctionPath, targetPath);
  }
}
