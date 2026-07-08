// 并行规划器 + 审查 — 四阶段编排循环
//
// 此模板驱动一个多阶段工作流：
//   阶段一（规划）：             一个 opus agent 分析待处理 issue，构建
//                               依赖关系图，并输出 <plan> JSON，
//                               列出无阻塞 issue 及其分支名。
//   阶段二（执行 + 审查）：      对每个 issue，通过 createSandbox() 创建
//                               沙箱。实现者先运行（最多 100 轮迭代）。
//                               如果产生了提交，审查者在同一沙箱、同一
//                               分支上运行（1 轮迭代）。所有 issue 流水线
//                               通过 Promise.allSettled() 并发执行。
//   阶段三（合并）：             一个 agent 将所有已完成分支合并到当前分支。
//
// 外部循环最多重复 MAX_ITERATIONS 次，以便每轮合并后能拾取新解除阻塞的
// issue。
//
// 用法：
//   npx tsx .sandcastle/main.mts
// 或添加到 package.json：
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  ensureCacheDirs,
  getBeadsDbPath,
  defaultSymlinkConfig,
  setupWorktreeSymlinks,
  setupSandcastleDirJunctions,
} from "./cache.ts";

// ---------------------------------------------------------------------------
// Windows shell quoting 修复
//
// sandcastle 内部使用 Unix 风格单引号做 shell 转义（shellEscape），
// 但 Windows cmd.exe 不认单引号——会当作普通字符原样传给 pi，
// 导致 pi 收到带引号的模型名（如 'opencode-go/deepseek-v4-pro'）而找不到模型。
// 此 wrapper 在 Windows 上将命令中的单引号替换为双引号。
// ---------------------------------------------------------------------------
function pi(
  model: string,
  options?: Parameters<typeof sandcastle.pi>[1],
): ReturnType<typeof sandcastle.pi> {
  const provider = sandcastle.pi(model, options);
  if (process.platform !== "win32") return provider;

  const origBuildPrint = provider.buildPrintCommand.bind(provider);
  return {
    ...provider,
    buildPrintCommand(args: Parameters<typeof origBuildPrint>[0]) {
      const result = origBuildPrint(args);
      // 将单引号参数替换为 cmd.exe 能识别的双引号
      return {
        ...result,
        command: result.command.replace(
          /'([^']*)'/g,
          (_: string, inner: string) => `"${inner.replace(/"/g, '\\"')}"`,
        ),
      };
    },
  };
}

// 规划器将其计划以 JSON 形式输出在 <plan> 标签中；Output.object 根据
// 此 schema 提取并验证。这里使用 Zod，但任何 Standard Schema 验证器
// 同样适用——Valibot、ArkType 等。参见 https://standardschema.dev。
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

// 从 .sandcastle/.env 加载环境变量（不会覆盖已有的环境变量）。
// .env.example 是带注释的模板，可复制后修改。
(function loadEnv() {
  const envPath = path.resolve(import.meta.dirname ?? __dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1).trim();
  }
})();

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// 每个 Agent 的模型和 thinking level，均从环境变量读取，有默认值兜底。
// 修改 .sandcastle/.env 即可切换，无需改动代码。
const AGENTS = {
  planner: {
    model: process.env.PLANNER_MODEL ?? "deepseek-v4-pro",
    thinking: (process.env.PLANNER_THINKING ?? "high") as ThinkingLevel,
  },
  implementer: {
    model: process.env.IMPLEMENTER_MODEL ?? "deepseek-v4-flash",
    thinking: (process.env.IMPLEMENTER_THINKING ?? "high") as ThinkingLevel,
  },
  reviewer: {
    model: process.env.REVIEWER_MODEL ?? "deepseek-v4-flash",
    thinking: (process.env.REVIEWER_THINKING ?? "high") as ThinkingLevel,
  },
  merger: {
    model: process.env.MERGER_MODEL ?? "deepseek-v4-flash",
    thinking: (process.env.MERGER_THINKING ?? "high") as ThinkingLevel,
  },
};

// 宿主仓库当前分支，作为审查 diff 的基准分支。
// 在循环外获取一次，避免反复调用 git。
// ---------------------------------------------------------------------------
// 目标目录 — 通过 --target <dir> 指定要操作的仓库（默认 Loop 自身）。
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const targetIdx = args.indexOf("--target");
const TARGET_DIR = targetIdx !== -1
  ? path.resolve(args[targetIdx + 1] ?? ".")
  : path.resolve(import.meta.dirname ?? __dirname, "..");

console.log(`目标目录：${TARGET_DIR}`);

// 预检：目标目录必须是 git 仓库
if (!fs.existsSync(path.join(TARGET_DIR, '.git'))) {
  console.error(`错误：${TARGET_DIR} 不是 git 仓库。请先执行 git init。`);
  process.exit(1);
}

const BASE_BRANCH = execSync("git rev-parse --abbrev-ref HEAD", {
  encoding: "utf-8",
  timeout: 10_000,
  cwd: TARGET_DIR,
}).trim();

// ---------------------------------------------------------------------------
// Loop v2 — 缓存目录初始化
//
// 所有运行时产物（沙箱日志、node_modules 缓存）
// 统一迁到 LOOP_DATA_DIR（默认 %LOCALAPPDATA%/Loop/），
// 工作目录只保留源码和模板配置。
// Beads 数据库使用目标目录自己的 .beads/。
// ---------------------------------------------------------------------------
const LOOP_DATA_DIR = ensureCacheDirs();
// Beads 数据库路径：有 --target 时用目标目录的 .beads/，否则用缓存
const BDS_DB_PATH = targetIdx !== -1
  ? path.join(TARGET_DIR, '.beads')
  : getBeadsDbPath(LOOP_DATA_DIR);
console.log(`Loop 数据目录：${LOOP_DATA_DIR}`);
console.log(`Beads 数据库：${BDS_DB_PATH}`);

// 将 sandcastle 的硬编码目录（.sandcastle/worktrees, .sandcastle/logs）
// 通过 Junction 重定向到 LOOP_DATA_DIR/sandcastle/ 下。
setupSandcastleDirJunctions(LOOP_DATA_DIR);
console.log(`Sandcastle worktrees → ${path.join(LOOP_DATA_DIR, "sandcastle", "worktrees")}`);
console.log(`Sandcastle logs     → ${path.join(LOOP_DATA_DIR, "sandcastle", "logs")}`);

// ---------------------------------------------------------------------------
// 启动预检：bd 命令是否存在 + beads 数据库是否已初始化
// ---------------------------------------------------------------------------

/** 检查 bd 命令是否可用，不可用则直接退出。 */
function ensureBdCommand(): void {
  try {
    execSync("bd --version", { encoding: "utf-8", timeout: 10_000, stdio: "pipe" });
  } catch {
    console.error("错误：未找到 bd 命令。请先安装 beads：npm install -g @gastownhall/beads");
    process.exit(1);
  }
}

/**
 * 检查 beads 数据库是否已初始化。
 * 目标项目：检查 .beads/config.yaml；默认（Loop 自身）：检查缓存路径。
 * 未初始化则自动执行 bd init。
 */
function ensureBeadsDb(dbPath: string, runInDir: string): void {
  if (fs.existsSync(path.join(dbPath, 'config.yaml'))) return;
  console.log('beads 数据库未初始化，执行 bd init…');
  execSync('bd init --non-interactive --skip-agents --skip-hooks', {
    encoding: 'utf-8',
    timeout: 30_000,
    cwd: runInDir,
    stdio: 'inherit',
  });
  console.log('beads 初始化完成。');
}

ensureBdCommand();
ensureBeadsDb(BDS_DB_PATH, TARGET_DIR);

// plan→execute→merge 循环无限运行，直到所有 issue 处理完毕。
// 没有待处理 issue 时会进入 IDLE_SLEEP_SECONDS 休眠，不会空转。
const MAX_ITERATIONS = Infinity;

// 没有可处理工单时的休眠秒数。
// 避免空转 tight loop 浪费资源。
const IDLE_SLEEP_SECONDS = parseInt(
  process.env.IDLE_SLEEP_SECONDS ?? "60",
  10,
);

// ---------------------------------------------------------------------------
// 轻量级预检工具
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 返回 beads --db 参数，指向 LOOP_DATA_DIR 下的 beads 数据库。 */
function beadsDbFlag(): string {
  return `--db "${BDS_DB_PATH}"`;
}

/** 运行 bd ready --json，返回原始 issue 数组。失败时抛异常。 */
function getReadyIssues(): unknown[] {
  const raw = execSync(`bd ready --json ${beadsDbFlag()}`, {
    encoding: "utf-8",
    timeout: 30_000,
    cwd: TARGET_DIR,
  });
  return JSON.parse(raw);
}

// 阶段二中同时运行的 issue 实现流水线数量上限。
// 每条流水线 = 一个 implementer + 一个 reviewer（同沙箱、同分支），
// 限制并发以防止 LLM API 速率限制和系统资源耗尽。
const MAX_CONCURRENT_ISSUES = parseInt(
  process.env.MAX_CONCURRENT_ISSUES ?? "5",
  10,
);

// 钩子在每次迭代开始前在沙箱内运行。
// npm install 确保沙箱始终有最新的依赖。
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Loop v2 — Symlink 配置：
// `symlinkPaths` 通过 Junction（Windows）或 symlink（POSIX）指向
// 共享缓存（LOOP_DATA_DIR/node_modules/），不复制到 worktree。
// `copyPaths` 按原有方式复制到 worktree。
// 参见 cache.ts 中的 setupWorktreeSymlinks()。
const symlinkConfig = defaultSymlinkConfig();

// ---------------------------------------------------------------------------
// 并发信号量
// ---------------------------------------------------------------------------

// 简单的 Promise 信号量，用于限制并发数量。
// acquire() 在有空闲槽位时立即返回，否则等待 release()。
function semaphore(limit: number) {
  let running = 0;
  const queue: (() => void)[] = [];

  return {
    acquire(): Promise<void> {
      if (running < limit) {
        running++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        queue.push(() => {
          running++;
          resolve();
        });
      });
    },
    release(): void {
      running--;
      const next = queue.shift();
      if (next) next();
    },
  };
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== 第 ${iteration} 轮迭代 ===\n`);

  // -------------------------------------------------------------------------
  // 同步远端 beads 数据库：先拉取其他机器 push 的工单，再检查本地待处理列表。
  // bd dolt pull 从 Dolt remote 拉取最新数据，确保 bd ready 能看到所有工单。
  // -------------------------------------------------------------------------
  try {
    console.log("同步远端 beads 数据库…");
    execSync(`bd dolt pull --remote origin ${beadsDbFlag()}`, {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: TARGET_DIR,
      stdio: "pipe",
    });
    console.log("bd dolt pull 完成。");
  } catch (err) {
    console.warn("bd dolt pull 失败（继续使用本地数据）：", err);
  }

  // -------------------------------------------------------------------------
  // 预检：在调用昂贵的 planner agent 之前，先用本地 CLI 检查是否有待处理
  // issue。bd ready 本身已排除被显式阻塞的工单，若返回空则直接跳过 planner。
  // -------------------------------------------------------------------------
  let readyIssues: unknown[];
  try {
    readyIssues = getReadyIssues();
  } catch (err) {
    console.warn("bd ready --json 执行失败，跳过预检，直接运行 planner：", err);
    readyIssues = [{ _fallback: true }]; // 非空哨兵，确保 planner 运行
  }

  if (readyIssues.length === 0) {
    console.log(
      `没有待处理 issue。${IDLE_SLEEP_SECONDS} 秒后重试…`,
    );
    await sleep(IDLE_SLEEP_SECONDS * 1000);
    continue;
  }

  // -------------------------------------------------------------------------
  // 阶段一：规划
  //
  // 规划 agent 读取待处理 issue，构建依赖图，选出无阻塞 issue。
  // 输出格式：用 <plan>/</plan> 包裹 JSON。
  // -------------------------------------------------------------------------
  const planResult = await sandcastle.run({
    hooks,
    sandbox: noSandbox(),
    name: "planner",
    maxIterations: 1,
    agent: pi(AGENTS.planner.model, { thinking: AGENTS.planner.thinking }),
    promptFile: "./.sandcastle/plan-prompt.md",
    promptArgs: {
      BD_DB_PATH: BDS_DB_PATH,
    },
  });

  // 从 stdout 提取 <plan>...</plan> 之间的 JSON
  // pi openai-completions 的 stdout 是 JSON Lines 流——每行一个 JSON 对象。
  // thinking 内容中可能包含 <plan> 片段，干扰直接搜索，因此需先解析
  // JSON Lines，只拼合 text 类型字段，再做标记匹配。
  let planText = "";
  for (const line of planResult.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      // 尝试多种常见 API 响应格式提取文本
      const parts: string[] = [];
      // message_update 中的 assistant message content
      for (const part of obj?.message?.content ?? []) {
        if (part?.type === "text" && typeof part?.text === "string") {
          parts.push(part.text);
        }
      }
      // 直接 text 字段
      if (typeof obj?.text === "string") {
        parts.push(obj.text);
      }
      planText += parts.join("");
    } catch {
      // 非 JSON 行（纯文本场景），直接拼合
      planText += line + "\n";
    }
  }

  // 用 lastIndexOf 定位最后一对 <plan>...</plan>，防止多片段拼接导致
  // 匹配到中间的无效对
  const openTag = "<plan>";
  const closeTag = "</plan>";
  const startIdx = planText.lastIndexOf(openTag);
  const endIdx = planText.indexOf(closeTag, startIdx + openTag.length);

  if (startIdx === -1 || endIdx === -1) {
    const tail = planText.slice(-500);
    console.error(
      "规划器 stdout 中未找到 <plan>…</plan> 块。提取文本尾部：\n" + tail,
    );
    throw new Error("规划器未输出有效的 <plan>…</plan> 块");
  }

  const rawJson = planText.slice(startIdx + openTag.length, endIdx).trim();
  const plan = planSchema.parse(JSON.parse(rawJson));

  const issues = plan.issues;

  if (issues.length === 0) {
    // 没有无阻塞的工作——全部完成或全部被阻塞。
    // bd ready 本身已过滤显式阻塞，此分支极少触发，作为兜底。
    console.log(
      `planner 返回空计划。${IDLE_SLEEP_SECONDS} 秒后重试…`,
    );
    await sleep(IDLE_SLEEP_SECONDS * 1000);
    continue;
  }

  console.log(
    `规划完成。${issues.length} 个 issue 可并行处理：`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // 阶段二：执行 + 审查
  //
  // 对每个 issue，通过 createSandbox() 创建沙箱，使实现者和审查者
  // 共享同一分支的同一沙箱实例。实现者先运行；如果产生提交，
  // 审查者在同一沙箱中运行。
  //
  // 通过信号量将并发限制在 MAX_CONCURRENT_ISSUES 以内，
  // 防止过多 Agent 实例同时运行导致 API 速率限制或系统资源耗尽。
  // Promise.allSettled 意味着一个失败的流水线不会取消其他流水线。
  // -------------------------------------------------------------------------

  const limiter = semaphore(MAX_CONCURRENT_ISSUES);

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      await limiter.acquire();
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: noSandbox(),
        hooks,
        // node_modules 走 Junction/symlink -> 共享缓存，不复制
        copyToWorktree: symlinkConfig.copyPaths,
      });

      // Loop v2: 在 worktree 中为 symlinkPaths 创建 Junction/symlink
      setupWorktreeSymlinks(
        sandbox.worktreePath,
        symlinkConfig,
        LOOP_DATA_DIR,
      );

      try {
        // 运行实现者
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 100,
          agent: pi(AGENTS.implementer.model, { thinking: AGENTS.implementer.thinking }),
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        // 仅在实现者产生了提交时才进行审查
        if (implement.commits.length > 0) {
          const review = await sandbox.run({
            name: "reviewer",
            maxIterations: 1,
            agent: pi(AGENTS.reviewer.model, { thinking: AGENTS.reviewer.thinking }),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              BRANCH: issue.branch,
              BASE_BRANCH,
            },
          });

          // 合并两次运行的提交，使合并阶段能看到所有提交。
          // 每次 sandbox.run() 只返回自己运行中的提交。
          return {
            ...review,
            commits: [...implement.commits, ...review.commits],
          };
        }

        return implement;
      } finally {
        await sandbox.close();
        limiter.release();
      }
    }),
  );

  // 记录所有抛出异常的 agent（网络错误、沙箱崩溃等）。
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) 失败：${outcome.reason}`,
      );
    }
  }

  // 只将实际产生了提交的分支传递给合并阶段。
  // 运行成功但没有产生提交的 agent 没有可合并的内容。
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\n执行完成。${completedBranches.length} 个分支有提交：`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // 所有 agent 都运行了但都没有产生提交——本轮没有可合并的内容。
    console.log("没有产生提交。没有需要合并的内容。");
    continue;
  }

  // -------------------------------------------------------------------------
  // 阶段三：合并
  //
  // 一个 agent 将所有已完成分支合并到当前分支，解决可能的冲突
  // 并运行测试以确认一切正常。
  //
  // {{BRANCHES}} 和 {{ISSUES}} 提示参数是列表，agent 用它们来
  // 知道要合并哪些分支、关闭哪些 issue。
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    sandbox: noSandbox(),
    name: "merger",
    maxIterations: 1,
    agent: pi(AGENTS.merger.model, { thinking: AGENTS.merger.thinking }),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // 分支名列表（markdown 格式，每行一个）。
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // issue ID 和标题列表（markdown 格式，每行一个）。
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\n分支已合并。");

  // -------------------------------------------------------------------------
  // 合并完成后，将本地 beads 工单状态变更（close/label 等）推送到远端。
  // 这样其他机器 pull 后能看到最新的工单状态。
  // -------------------------------------------------------------------------
  try {
    console.log("推送 beads 状态变更到远端…");
    execSync(`bd dolt push --remote origin ${beadsDbFlag()}`, {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: TARGET_DIR,
      stdio: "pipe",
    });
    console.log("bd dolt push 完成。");
  } catch (err) {
    console.warn("bd dolt push 失败：", err);
  }
}

console.log("全部完成。");
