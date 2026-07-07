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

// plan→execute→merge 循环的最大迭代次数。
// 如果 backlog 很大可以调高；快速冒烟测试时调低。
const MAX_ITERATIONS = 10;

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

// 在每个沙箱启动前将 node_modules 从宿主机复制到 worktree 中。
// 避免从头完整 npm install；上面的钩子处理平台特定的二进制文件
// 以及自上次复制以来新增的包。
const copyToWorktree = ["node_modules"];

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
  console.log(`\n=== 第 ${iteration}/${MAX_ITERATIONS} 轮迭代 ===\n`);

  // -------------------------------------------------------------------------
  // 阶段一：规划
  //
  // 规划 agent（使用 opus 以获得更深推理能力）读取待处理 issue 列表，
  // 构建依赖关系图，并选择当前可以并行处理的 issue
  //（即对其他待处理 issue 没有阻塞依赖的 issue）。
  //
  // 它输出一个 <plan> JSON 块——Output.object 负责解析和验证。
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: noSandbox(),
    name: "planner",
    // 一轮迭代足够：规划器只需要阅读和推理，不需要写代码。
    // （结构化输出要求 maxIterations: 1。）
    maxIterations: 1,
    // 使用 Opus 进行规划：依赖分析受益于更深的推理能力。
    agent: sandcastle.pi(AGENTS.planner.model, { thinking: AGENTS.planner.thinking }),
    promptFile: "./.sandcastle/plan-prompt.md",
    // 提取 <plan> JSON 并验证为类型化对象。如果标签缺失、JSON 格式错误
    // 或验证失败，会抛出 StructuredOutputError——这将中止循环。
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues;

  if (issues.length === 0) {
    // 没有无阻塞的工作——要么全部完成，要么全部被阻塞。
    console.log("没有无阻塞的 issue 需要处理。退出。");
    break;
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
        copyToWorktree,
      });

      try {
        // 运行实现者
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 100,
          agent: sandcastle.pi(AGENTS.implementer.model, { thinking: AGENTS.implementer.thinking }),
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
            agent: sandcastle.pi(AGENTS.reviewer.model, { thinking: AGENTS.reviewer.thinking }),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              BRANCH: issue.branch,
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
    agent: sandcastle.pi(AGENTS.merger.model, { thinking: AGENTS.merger.thinking }),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // 分支名列表（markdown 格式，每行一个）。
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // issue ID 和标题列表（markdown 格式，每行一个）。
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\n分支已合并。");
}

console.log("全部完成。");
