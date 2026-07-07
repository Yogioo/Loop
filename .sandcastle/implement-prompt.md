# 任务

修复 issue {{TASK_ID}}：{{ISSUE_TITLE}}

使用 `bd show <ID>` 拉取该 issue。如果它有父级 PRD，也一并拉取。

只处理指定的这个 issue。

在分支 {{BRANCH}} 上工作。进行提交并运行测试。

# 上下文

以下是最近 10 次提交：

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# 探索

探索仓库，将能帮助你完成任务的相关信息填充到上下文窗口中。

特别注意涉及代码相关部分的测试文件。

# 执行

如果适用，使用 RGR（红-绿-重构）来完成任务。

1. RED（红）：先写一个测试
2. GREEN（绿）：编写实现代码使测试通过
3. REPEAT（重复）：重复以上步骤直到完成
4. REFACTOR（重构）：重构代码

# 反馈循环

提交前运行 `npm run typecheck` 和 `npm run test`，确保测试通过。

# 提交

进行一次 git 提交。提交信息必须包含：

1. 以 `RALPH:` 前缀开头
2. 包含已完成的任务 + PRD 引用
3. 做出的关键决策
4. 修改的文件
5. 阻碍项或下一轮迭代的备注

保持简洁。

# 关于 ISSUE

如果任务未完成，在 issue 上留下评论说明已完成的工作。

不要关闭 issue——这将在之后处理。

完成后，输出 <promise>COMPLETE</promise>。

# 最终规则

一次只处理一个任务。
