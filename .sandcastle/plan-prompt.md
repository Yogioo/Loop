# ISSUE 列表

以下是仓库中的待处理 issue：

<issues-json>

!`bd --db {{BD_DB_PATH}} ready --json --label ready-for-agent`

</issues-json>

以上列表已过滤，仅包含可以开始工作的 issue。

# 任务

分析待处理 issue 并构建依赖关系图。对每个 issue，判断它是否**阻塞**其他 issue 或**被**其他 issue 阻塞。

issue B **被** issue A 阻塞的条件是：

- B 需要 A 所引入的代码或基础设施
- B 和 A 修改重叠的文件或模块，并行工作可能产生合并冲突
- B 的需求依赖于 A 将要确立的决策或 API 形态

如果一个 issue 对其他待处理 issue 没有任何阻塞依赖，它就是**无阻塞**的。

为每个无阻塞的 issue 分配分支名，格式严格为 `sandcastle/issue-{id}`（不要加 slug 或其他后缀）。这必须是确定性的，以便重新规划同一个 issue 时始终生成相同的分支名，保留累积的进度。

# 输出

将你的计划以 JSON 对象形式输出，包裹在 `<plan>` 标签中：

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42"}]}
</plan>

只包含无阻塞的 issue。如果每个 issue 都被阻塞，则包含唯一一个优先级最高的候选项（依赖最少或最弱的那个）。

即使没有任务可做，也始终输出 `<plan>` 标签。如果完全没有 issue 需要处理，输出 `<plan>{"issues": []}</plan>` 以便运行能干净退出。
