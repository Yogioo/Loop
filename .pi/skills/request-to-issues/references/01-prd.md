# Phase 2: PRD（产出规格）

**是什么**：将 Phase 1 达成的共识和 codebase 现状，综合为一份结构化的 PRD，创建 issue 后**立即关闭**——PRD 是容器而非可执行工作单元，不应被 Agent 认领。

**→ 转换条件**：PRD issue 已创建并关闭，拿到了 number 和 URL。

---

## 执行步骤

### 1. 探索 codebase

如果还没探索 repo，先探索以理解 codebase 当前状态。PRD 中始终使用项目 domain glossary vocabulary，并遵守相关 ADRs。

### 2. 草拟 testing seams

草拟准备在哪些 seams 上测试这个 feature。优先使用现有 seams，而不是新增 seams。使用尽可能高层的 seam。如果确实需要新增 seams，尽可能在最高层提出。

与用户确认这些 seams 是否符合预期。

### 3. 按模板写 PRD

使用下方模板撰写完整 PRD 内容。

### 4. 创建并立即关闭

```bash
id=$(bd q --title "PRD: <title>") && bd close "$id"
```

然后用 `bd update` 写入 body 内容。记录 issue number。

## PRD 模板

### Problem Statement

用户正在面对的问题，从用户视角描述。

### Solution

问题的解决方案，从用户视角描述。

### User Stories

一份很长的编号 user stories 列表。每条格式：

```
1. As an <actor>, I want a <feature>, so that <benefit>
```

示例：
> 1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending

这份 user stories 列表应该非常完整，覆盖 feature 的所有方面。

### Implementation Decisions

已作出的 implementation decisions 列表。可以包括：
- 将 build/modify 的 modules
- 将 modify 的 module interfaces
- 来自 developer 的技术澄清
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

不要包含具体 file paths 或 code snippets（它们可能很快过时）。

例外：如果 prototype 产出的 snippet 比 prose 更精确地编码了某个决策（state machine、reducer、schema、type shape），可以内联到相关 decision 中，并简短说明它来自 prototype。只保留决策密集部分，不要放完整 working demo。

### Testing Decisions

已作出的 testing decisions 列表。包括：
- 什么是好测试的描述（只测试 external behavior，不测试 implementation details）
- 哪些 modules 会被测试
- 测试的 prior art（即 codebase 中类似类型的 tests）

### Out of Scope

本 PRD 范围外事项的描述。

### Further Notes

关于 feature 的其他 notes。
