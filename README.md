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
| **[pi](https://pi.dev)** | AI 编程助手 | `npm install -g @mariozechner/pi-coding-agent` |
| **[beads](https://github.com/gastownhall/beads)** | Issue 跟踪 | `npm install -g @gastownhall/beads` |
| **[Git](https://git-scm.com)** | 版本控制 | `winget install Git.Git` |

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

## 技能

| 技能 | 方式 | 说明 |
|------|------|------|
| **grill-me** | 系统提示词（始终生效） | 追问式访谈，打磨计划 |
| **to-prd** | UI 按钮 / `/skill:to-prd` | 基于对话生成 PRD |
| **to-issues** | UI 按钮 / `/skill:to-issues` | 把 PRD 拆成可领取的 Issues |

## 项目结构

```
loop/
├── src/
│   ├── chat-server.mts    # Express 前端服务器
│   ├── pi-rpc.mts         # pi RPC 进程管理
│   └── public/index.html  # 聊天界面
├── .sandcastle/
│   └── main.mts           # AgentLoop 编排（规划→实现→审查→合并）
├── skills/                # 技能文件
│   ├── grill-me/
│   ├── to-prd/
│   └── to-issues/
├── start.bat              # 启动前端
└── loop.bat               # 启动后端
```
