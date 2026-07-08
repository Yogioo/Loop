# Loop

Agent 循环，用于 Agent 编排和开发项目。

## 依赖

| 工具 | 用途 | 安装 |
|------|------|------|
| **[pi](https://pi.dev)** | AI 编程助手 | `npm install -g @mariozechner/pi-coding-agent` |
| **[beads](https://github.com/zenozeng/beads)** | 构建与任务编排 | `npm install -g beads` |
| **[Git for Windows](https://git-scm.com/downloads/win)** | 提供 `cp`、`bash` 等命令 | [下载安装](https://git-scm.com/downloads/win) |
| **[pi-feishu-lark](https://www.npmjs.com/package/pi-feishu-lark)**（可选） | 飞书/Lark 集成 | `pi install npm:pi-feishu-lark` |

> **Windows 用户注意**：sandcastle 内部会调用 `cp` 命令复制 node_modules，部分钩子依赖 `bash`。\
> 安装 Git for Windows 后，需将 `C:\Program Files\Git\usr\bin` 加入**系统环境变量** PATH，然后重启终端。\
> \
> ```powershell\
> # PowerShell 管理员执行（永久添加）\
> [Environment]::SetEnvironmentVariable(\\\
>     'PATH',\\\
>     [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';C:\\Program Files\\Git\\usr\\bin',\\\
>     'Machine'\\\
> )\
> ```

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

# 3. 初始化 beads 数据库（首次运行必须）
bd init

# 4. 启动 Agent 后台循环
./run.bat

# 5. 启动 Beads UI
./beads-ui.bat
```

## 常见问题

### `spawn cp ENOENT`（Windows）

```
(FiberFailure) CopyToWorktreeError: Failed to copy node_modules to worktree: spawn cp ENOENT
```

`sandcastle` 复制 node_modules 时找不到 `cp` 命令。\
→ 安装 [Git for Windows](https://git-scm.com/downloads/win)，并将 `C:\Program Files\Git\usr\bin` 加入系统 PATH（见上方依赖说明）。

### `bd` 命令找不到

`bd` 实际安装到了 `C:\Users\JinJin\bin\bd.exe`，如果该目录不在 Windows 用户 PATH 中会报 `'bd' is not recognized`。

修复：将 `C:\Users\JinJin\bin` 加入用户环境变量 PATH，然后重启终端。

```powershell
# PowerShell 中执行（永久添加）
[Environment]::SetEnvironmentVariable('PATH', [Environment]::GetEnvironmentVariable('PATH', 'User') + ';C:\Users\JinJin\bin', 'User')
```

### `no beads database found`

```
Error: no beads database found
Hint: run 'bd init' to create a new database
```

首次克隆项目后必须运行 `bd init` 来初始化 beads 数据库。

### `Cannot find module '.sandcastle/main.ts'`

`run.bat` 引用的是 `.sandcastle/main.ts`，但实际文件可能是 `.sandcastle/main.mts`。确认文件名后修改 `run.bat` 中的路径即可。

### PowerShell 中 PATH 不刷新

新安装的全局 npm 包在 PowerShell 中 `where.exe` 找不到是正常的——PowerShell 启动时缓存了 PATH。关闭并重新打开 PowerShell 即可。
