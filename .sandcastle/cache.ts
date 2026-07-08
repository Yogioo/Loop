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
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Cache Directory Resolution
// ---------------------------------------------------------------------------

/** Subdirectory names under LOOP_DATA_DIR. */
export const SUBDIRS = {
  beads: "beads",
  sandcastle: "sandcastle",
  logs: "logs",
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
  const env = process.env.LOOP_DATA_DIR?.trim();
  if (env) {
    return path.resolve(env);
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

  // Ultimate fallback: current directory
  return path.resolve(process.cwd(), ".loop-data");
}

/** Resolve a subdirectory path under the loop data directory. */
function getSubdirPath(subdir: string, dataDir?: string): string {
  return path.resolve(dataDir ?? getLoopDataDir(), subdir);
}

/** Path to the beads database directory. */
export function getBeadsDbPath(dataDir?: string): string {
  return getSubdirPath(SUBDIRS.beads, dataDir);
}

/** Path to the sandcastle worktrees directory. */
export function getSandcastlePath(dataDir?: string): string {
  return getSubdirPath(SUBDIRS.sandcastle, dataDir);
}

/** Path to the logs directory. */
export function getLogsPath(dataDir?: string): string {
  return getSubdirPath(SUBDIRS.logs, dataDir);
}

/** Path to the shared node_modules cache directory. */
export function getNodeModulesCachePath(dataDir?: string): string {
  return getSubdirPath(SUBDIRS.nodeModules, dataDir);
}

/**
 * Ensure all cache subdirectories exist, creating them as needed.
 * Returns the data dir root.
 */
export function ensureCacheDirs(dataDir?: string): string {
  const root = dataDir ?? getLoopDataDir();
  for (const subdir of Object.values(SUBDIRS)) {
    const p = path.resolve(root, subdir);
    fs.mkdirSync(p, { recursive: true });
  }
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

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });

  if (process.platform === "win32") {
    // mklink /J requires the link name WITHOUT trailing backslash
    const link = linkPath.replace(/[/\\]+$/, "");
    const target = targetPath.replace(/[/\\]+$/, "");
    execSync(`cmd /c mklink /J "${link}" "${target}"`, {
      stdio: "pipe",
      timeout: 10_000,
    });
  } else {
    // POSIX: standard symlink
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
 * - node_modules → shared cache via Junction
 * - .sandcastle  → shared cache via Junction (prompt templates change rarely)
 * Everything else copies normally.
 */
export function defaultSymlinkConfig(): SymlinkConfig {
  return {
    symlinkPaths: ["node_modules", ".sandcastle"],
    copyPaths: [],
  };
}

/**
 * Create junctions/symlinks inside a worktree for the configured paths.
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

    const source =
      relPath === "node_modules"
        ? cacheSource
        : path.resolve(process.cwd(), relPath);

    if (relPath === "node_modules") {
      fs.mkdirSync(cacheSource, { recursive: true });
    }

    createJunction(linkTarget, source);
  }
}
