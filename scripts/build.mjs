/**
 * Build standalone .exe for Loop frontend & backend (Node.js SEA).
 *
 * Output: dist/loop-frontend.exe, dist/loop-backend.exe
 *
 * Prerequisites: npm install, global postject (auto-installed if missing)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

function run(cmd, opts) {
  execSync(cmd, { cwd: opts?.cwd ?? ROOT, stdio: "inherit", timeout: 120_000 });
}

function sleepSync(ms) {
  const sec = Math.ceil(ms / 1000);
  // Use a command that blocks for the given time
  if (process.platform === "win32") {
    execSync(`ping -n ${sec + 1} 127.0.0.1`, { stdio: "ignore", timeout: ms + 5000 });
  } else {
    execSync(`sleep ${ms / 1000}`, { stdio: "ignore", timeout: ms + 5000 });
  }
}

/** Bundle TS → CJS, fixing import.meta.url → CJS __filename / __dirname. */
async function bundle(entry, name, defines = {}) {
  const outfile = path.join(DIST, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile,
    logLevel: "error",
    define: Object.fromEntries(
      Object.entries(defines).map(([k, v]) => [k, JSON.stringify(v)])
    ),
  });

  // Post-process: replace import.meta with CJS globals
  // esbuild renders import_meta as {} in CJS format
  let code = fs.readFileSync(outfile, "utf-8");

  // Fix 1: var __dirname = ...import_meta... → var __dirname = __dirname;
  code = code.replace(
    /var __dirname\s*=\s*[^;]*import_meta[^;]*;/g,
    "var __dirname = __dirname;"
  );

  // Fix 2: import_meta.dirname → __dirname
  code = code.replace(/import_meta\s*\.\s*dirname/g, "__dirname");

  // Fix 3: (0, createRequire)(import_metaN.url) → CJS-friendly
  //         esbuild generates this pattern for sandcastle bundled code
  code = code.replace(
    /createRequire\)\s*\(\s*import_meta\d*\s*\.\s*url\s*\)/g,
    'createRequire)("file://"+__filename)'
  );

  // Fix 4: remaining import_metaN.url → "file://"+__filename
  code = code.replace(/import_meta\d*\s*\.\s*url/g, '"file://"+__filename');
  fs.writeFileSync(outfile, code);

  const size = (fs.statSync(outfile).size / 1024).toFixed(0);
  console.log(`  Bundled: ${outfile} (${size} KB)`);
  return outfile;
}

/** Build .exe from CJS bundle via Node.js SEA. */
function buildExe(bundlePath, exeName) {
  const base = path.basename(bundlePath, ".cjs");
  const dir = path.dirname(bundlePath);

  // Use the bundle directly as the SEA entry point (no launcher needed)
  const configPath = path.join(dir, `${base}.sea.json`);
  const blobPath = path.join(dir, `${base}.blob`);
  fs.writeFileSync(configPath, JSON.stringify({
    main: path.basename(bundlePath),
    output: path.basename(blobPath),
    disableExperimentalSEAWarning: true,
  }, null, 2));

  // Generate blob
  run(`node --experimental-sea-config "${configPath}"`, { cwd: dir });

  // Kill any running instance before overwriting
  const exePath = path.join(DIST, exeName);
  try {
    if (fs.existsSync(exePath)) fs.unlinkSync(exePath);
  } catch {
    // On Windows, try taskkill then retry
    if (process.platform === "win32") {
      try { execSync(`taskkill /f /im ${exeName}`, { stdio: "ignore" }); } catch {}
      sleepSync(1000);
      try { fs.unlinkSync(exePath); } catch { /* give up, copyFile will fail with clear error */ }
    }
  }

  // Copy node.exe and inject blob
  fs.copyFileSync(process.execPath, exePath);

  try { execSync("npx postject --version", { stdio: "pipe", timeout: 5000 }); }
  catch { run("npm install -g postject"); }

  run(
    `npx postject "${exePath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { cwd: dir }
  );

  // Cleanup intermediates (keep only .exe)
  fs.unlinkSync(blobPath);
  fs.unlinkSync(configPath);
  fs.unlinkSync(bundlePath);

  const size = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ${exeName} (${size} MB)\n`);
}

// ---------------------------------------------------------------------------

console.log("=== Loop Build ===\n");

// Clean previous build artifacts (keep only .exe if still running)
try {
  for (const f of fs.readdirSync(DIST)) {
    if (f.endsWith('.exe')) continue;
    fs.rmSync(path.join(DIST, f), { recursive: true, force: true });
  }
} catch { /* dist may not exist yet */ }
fs.mkdirSync(DIST, { recursive: true });

console.log("Building frontend (chat-server)...");
const skillContent = (name) => fs.readFileSync(
  path.join(ROOT, "skills", name, "SKILL.md"), "utf-8"
);
const indexHtml = fs.readFileSync(
  path.join(ROOT, "src", "public", "index.html"), "utf-8"
);
buildExe(
  await bundle(
    path.join(ROOT, "src", "chat-server.mts"),
    "loop-frontend",
    {
      __SKILL_GRILL_ME: skillContent("grill-me"),
      __SKILL_TO_PRD: skillContent("to-prd"),
      __SKILL_TO_ISSUES: skillContent("to-issues"),
      __INDEX_HTML: indexHtml,
    }
  ),
  "loop-frontend.exe"
);

console.log("Building backend (agent-loop)...");
// 读取模板文件内容，注入为编译时常量（供 main.mts 的 auto-init 使用）
const tpl = (name) => fs.readFileSync(
  path.join(ROOT, ".sandcastle", name), "utf-8"
);
buildExe(
  await bundle(
    path.join(ROOT, ".sandcastle", "main.mts"),
    "loop-backend",
    {
      __TPL_PLAN_PROMPT: tpl("plan-prompt.md"),
      __TPL_IMPLEMENT_PROMPT: tpl("implement-prompt.md"),
      __TPL_REVIEW_PROMPT: tpl("review-prompt.md"),
      __TPL_MERGE_PROMPT: tpl("merge-prompt.md"),
      __TPL_CODING_STANDARDS: tpl("CODING_STANDARDS.md"),
      __TPL_ENV_EXAMPLE: tpl(".env.example"),
    }
  ),
  "loop-backend.exe"
);

console.log("Done!");
console.log(`  ${path.join(DIST, "loop-frontend.exe")}`);
console.log(`  ${path.join(DIST, "loop-backend.exe")}`);
