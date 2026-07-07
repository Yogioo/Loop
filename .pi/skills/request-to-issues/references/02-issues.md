# Phase 3: Issues（垂直拆分 + 收尾）

**是什么**：把已关闭的 PRD 拆成 tracer-bullet 垂直切片 issues，发布后在 PRD 上补 closing comment 并报告用户。这是最后一个阶段。

**→ 结束条件**：子 issues 全部发布，closing comment 已补，已报告用户。

---

## 执行步骤

### 1. 收集上下文

读取已关闭的 PRD issue（`bd show <prd-number>`），获取完整内容。基于 conversation context 和 PRD 内容工作。

### 2. 探索 codebase（可选）

如果还没探索，先探索以理解代码当前状态。Issue titles 和 descriptions 使用项目 domain glossary vocabulary，遵守相关 ADRs。

### 3. 草拟垂直切片

把 PRD 拆成 **tracer bullet** issues。每个 issue 是一个薄 vertical slice，end-to-end 穿过所有 integration layers，而不是某一层的 horizontal slice。

Slices 分类：
- **HITL**：需要人类交互，例如 architecture decision 或 design review
- **AFK**：可无人交互地实现并合并，尽可能优先 AFK

垂直切片规则：
- 每个 slice 都交付一条窄但**完整**的路径，穿过每一层（schema、API、UI、tests）
- 完成后的 slice 自身可 demo 或验证
- 偏好多而薄的 slices，而不是少而厚的 slices

### 4. 与用户确认

把 proposed breakdown 作为编号列表展示。每个 slice 显示：
- **Title**：短描述名
- **Type**：HITL / AFK
- **Blocked by**：哪些其他 slices 必须先完成（如果有）
- **User stories covered**：覆盖哪些 user stories

询问用户：
- 粒度是否合适？（too coarse / too fine）
- 依赖关系是否正确？
- 是否需要合并或继续拆分某些 slices？
- HITL 和 AFK 标记是否正确？

迭代直到用户批准。

### 5. 发布子 issues

对每个批准的 slice，按依赖顺序（blockers first）发布新 issue 到 issue tracker，应用正确的 triage label（AFK 的加 `ready-for-agent`）。

## Issue 模板

```markdown
## Parent

对 issue tracker 中 parent issue 的引用（如果 source 是现有 issue；否则省略本 section）。

## What to build

这个 vertical slice 的简洁描述。描述 end-to-end behavior，不要按 layer-by-layer implementation 描述。

避免具体 file paths 或 code snippets（它们很快会过时）。例外：如果 prototype 产出的 snippet 比 prose 更精确地编码了某个决策（state machine、reducer、schema、type shape），可以内联在这里，并简短说明它来自 prototype。保留决策密集部分，不要放完整 working demo。

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- 对 blocking issue 的引用（如果有）

如果没有 blocker，写 "None - can start immediately"。
```

### 6. 在 PRD 上补 closing comment

所有子 issues 发布后，在已关闭的 PRD issue 上添加 comment：

```bash
bd comment <prd-issue-number> --body "
## 本 PRD 已分解为以下垂直切片

| # | Issue | Type | Blocked By |
|---|-------|------|------------|
| #X | Title | AFK | None |
| #Y | Title | AFK | #X |
| #Z | Title | HITL | None |

共 N 个 issues，其中 M 个 AFK、K 个 HITL。

**请从 unblocked issues 开始认领，按依赖顺序推进。不要认领本 PRD issue。**
"
```

### 7. 向用户报告

列出产出了哪些子 issues，建议从哪里开始（unblocked issues 优先）。
