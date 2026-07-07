# Loop

Agent 循环，用于 Agent 编排和开发项目。

## 依赖

- **[pi](https://pi.dev)** — AI 编程助手（[GitHub](https://github.com/badlogic/pi-mono)）
- **[beads](https://github.com/zenozeng/beads)** — 构建与任务编排工具
- **[pi-feishu-lark](https://www.npmjs.com/package/pi-feishu-lark)**（可选）— 飞书/Lark 集成扩展

## 安装

```bash
# 安装 pi
npm install -g @mariozechner/pi-coding-agent

# 安装 beads
npm install -g beads

# 安装飞书集成（可选）
pi install npm:pi-feishu-lark
```

## 快速开始

```bash
# 1. 进入项目目录，启动 pi
cd C:/PYJ/loop
pi

# 2. 在 pi 中使用 request-to-issues 技能，将需求拆分为可执行的 issues

# 3. 启动 Agent 后台循环
./run.bat

# 4. 启动 Beads UI
./beads-ui.bat
```
