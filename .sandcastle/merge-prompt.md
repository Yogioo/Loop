# 任务

将以下分支合并到当前分支：

{{BRANCHES}}

对每个分支：

1. 运行 `git merge <branch> --no-edit`
2. 如果存在合并冲突，通过阅读双方代码并选择正确的解决方案来智能解决
3. 解决冲突后，运行 `npm run typecheck` 和 `npm run test` 验证一切正常
4. 如果测试失败，先修复问题再继续处理下一个分支

所有分支合并完成后，进行一次提交来总结本次合并。

# 关闭 ISSUE

对每个已合并的分支，使用以下命令关闭其 issue：

`bd close <ID> --reason="Completed by Sandcastle"`

以下是所有 issue：

{{ISSUES}}

完成所有可合并的工作后，输出 <promise>COMPLETE</promise>。
