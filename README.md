# Loop

Agent 驱动开发工作流 — 从对话到 PRD 到自动实现。

## 架构

```
你 ──→  Chat Server (前端)  ──→  pi RPC (grill-me 追问式访谈)
               │                        │
               ▼                        ▼
         📋 PRD 按钮              /skill:to-prd
         📝 Issues 按钮           /skill:to-issues
               │                        │
               ▼                        ▼
           .beads/ 数据库  ←──  AgentLoop (后端)
                                        │
                               planner → implementer
                               → reviewer → merger
```

| 角色 | 命令 | 说明 |
|------|------|------|
| **Chat 前端** | `npm start` 或 `start.bat` | 浏览器对话界面，追问打磨计划，生成 PRD，拆 Issues |
| **AgentLoop 后端** | `npm run loop` 或 `loop.bat` | 自动领取 issue → 实现 → 审查 → 合并，循环运行 |

## 依赖

| 工具 | 用途 | 安装 |
|------|------|------|
| **[pi](https://pi.dev)** | AI 编程助手（子进程调用，不在 exe 内） | `npm install -g @mariozechner/pi-coding-agent` |
| **[beads](https://github.com/gastownhall/beads)** | Issue 跟踪（子进程调用，不在 exe 内） | `npm install -g @gastownhall/beads` |
| **[Git for Windows](https://git-scm.com)** | 版本控制 + `cp`/`bash` 命令 | `winget install Git.Git` |

## 依赖（仅开发/构建时需要）

| 工具 | 用途 | 安装 |
|------|------|------|
| **[Node.js](https://nodejs.org)** | 运行时 & SEA 打包 | `winget install OpenJS.NodeJS` |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动前端（浏览器打开聊天界面）
npm start
# 或双击 start.bat

# 3. 在聊天中描述需求 → 点击 📋 PRD 生成规格 → 点击 📝 Issues 拆分任务

# 4. 启动后端（自动实现 issues）
npm run loop
# 或双击 loop.bat

# （可选）打包为独立 exe，无需 Node.js
双击 build.bat
```

## 在任意项目中运行

通过 `--target` 指向你的开发项目，Loop 会在那个目录里操作，不污染 Loop 自身：

```bash
# 前端：在目标项目中对话、生成 PRD、拆 Issues
npm start -- --target /path/to/your-project

# 后端：自动实现目标项目的 issues
npm run loop -- --target /path/to/your-project
```

目标项目需要是 git 仓库。如果还没初始化 beads，AgentLoop 会自动执行 `bd init`（仅创建数据库，不产生额外文件）。

## 打包为独立 exe

Loop 可以打包为不依赖 Node.js 的独立 `.exe`。

> exe 内含 Node.js 运行时，所以较大。`pi`、`bd`、`git` 作为子进程调用，仍需系统安装。
>
> 本质 = 自带 Node.js 的 JS bundle，不是静态编译。

### 本地打包

双击 `build.bat` 或运行：

```bash
npm run build
# 产出 dist/loop-frontend.exe (~87 MB)
# 产出 dist/loop-backend.exe  (~88 MB)
```

```bash
# 直接用 exe，不需要装 Node.js / npm / tsx
loop-frontend.exe --target C:\your-project
loop-backend.exe  --target C:\your-project
```

### CI/CD 自动发布（GitHub Actions）

推送 `v` 开头的 tag 即可触发 GitHub Actions 自动构建 exe 并发布 Release：

```bash
# 打标签 + 推送，剩下的 GitHub 自动完成
git tag v0.2.1
git push origin v0.2.1
```

**流水线自动执行：**

| 步骤 | 说明 |
|------|------|
| 检出代码 | `actions/checkout@v4` |
| 安装 Node.js 24 | `actions/setup-node@v4` |
| 安装依赖 | `npm ci` |
| 构建 EXE | `npm run build`（esbuild bundle → Node.js SEA → postject 注入） |
| 压缩 | `7z a loop-windows-x64.7z` |
| 发布 Release | 上传 `.exe` + `.7z` 到 GitHub Release，自动生成 Release Notes |

**Release 产物（每个版本自动生成）：**
- `loop-frontend.exe` — 聊天前端 (~87 MB)
- `loop-backend.exe` — AgentLoop 后端 (~88 MB)
- `loop-windows-x64.7z` — 两个 exe 的压缩包 (~50 MB)

**也可手动触发**：GitHub 仓库 → Actions → Build & Release → Run workflow。

**配置文件**：`.github/workflows/release.yml`，基于 `windows-latest`  runner，公开仓库免费使用。

## 技能

| 技能 | 方式 | 说明 |
|------|------|------|
| **grill-me** | 系统提示词（始终生效） | 追问式访谈，打磨计划 |
| **to-prd** | UI 按钮 / `/skill:to-prd` | 基于对话生成 PRD |
| **to-issues** | UI 按钮 / `/skill:to-issues` | 把 PRD 拆成可领取的 Issues |

## 项目结构

```
loop/
├── .github/
│   └── workflows/
│       └── release.yml    # CI/CD：推送 tag 自动构建 exe + 发布 Release
├── src/
│   ├── chat-server.mts    # Express 前端服务器
│   ├── pi-rpc.mts         # pi RPC 进程管理
│   └── public/index.html  # 聊天界面
├── .sandcastle/
│   └── main.mts           # AgentLoop 编排（规划→实现→审查→合并）
├── scripts/
│   └── build.mjs          # exe 打包脚本（本地 & CI 共用）
├── skills/                # 技能文件
│   ├── grill-me/
│   ├── to-prd/
│   └── to-issues/
├── dist/                  # 构建产物（gitignore）
│   ├── loop-frontend.exe
│   └── loop-backend.exe
├── start.bat              # 启动前端
├── loop.bat               # 启动后端
└── build.bat              # 打包 exe
```
