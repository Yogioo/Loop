---
name: request-to-issues
description: 将用户请求编排为完整的 issue 分解流程：grill 打磨计划 → 产出 PRD → 拆分为垂直切片 issues。适用于用户想把一个需求/想法/计划转成可独立领取的 AFK issues 时。当用户说 "request-to-issues"、"把这个拆成 issues"、"从需求到 issues"、"完整走一遍流程" 时触发。
disable-model-invocation: true
---

# Request to Issues

三个阶段串行执行。只有当前阶段的转换条件满足后才能进入下一阶段。

## Phase 1: Grill

围绕这个计划的每个方面持续访谈用户，直到达成共同理解。沿着 design tree 的每个分支往下走，逐一解决决策之间的依赖。每个问题都要附上推荐答案。

一次只问一个问题，并等待用户反馈后再继续。一次问多个问题会让人失去方向。

如果某个问题可以通过探索 codebase 回答，就去探索 codebase，而不是问用户。

**→ Phase 2 条件**：用户确认已达成共同理解。

## Phase 2: PRD

综合共识产出 PRD，创建 issue 后立即关闭——PRD 是容器，不应被 Agent 认领。详见 [references/01-prd.md](references/01-prd.md)。

**→ Phase 3 条件**：PRD issue 已创建并关闭，拿到 number 和 URL。

## Phase 3: Issues

把 PRD 拆成 tracer-bullet 垂直切片 issues，发布后在已关闭的 PRD 上补 closing comment 并报告用户。详见 [references/02-issues.md](references/02-issues.md)。

**→ 结束条件**：子 issues 全部发布，closing comment 已补，已报告用户。
