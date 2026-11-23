# run-watch · 长任务看守

[English](README.md)

Claude 桌面版的一个 mod，**从日志文件看守长时间的任务，不调用模型**：显示进度和预计剩余时间，任务完成、失败或不再输出时通知你。训练、仿真、构建都适用：启动之后不用盯着，有事它会告诉你。

## 它做什么

- **`/watch ./run.log --pid 4242`** 开始看守。选项：`[名字]`、`--pid N`、`--done 正则`、`--fail 正则`、`--progress 正则`、`--stall 30m`。`/watch list`、`/watch stop <#>`、`/watch clear`。
- **进度和预计剩余时间**取自日志末尾最后一个 `n%` 或 `a/b`（也可以用 `--progress` 自己的正则，带一到两个捕获组）。
- **完成**：出现 `--done` 的内容、进程（`--pid`）结束，或进度到 100%。**失败**：出现默认的失败特征（Traceback、FATAL、Segmentation fault、Killed、CUDA out of memory、MemoryError、OutOfMemory）或你的 `--fail`；进程在完成标志出现之前就结束也算失败。**停滞**：日志 30 分钟（`--stall`）没有增长。
- **你一定看得到的通知**：弹出提示，macOS 上还有系统通知。
- 每分钟检查一次，每个日志只读最后 16 KB，最多同时看 12 个。

## 安装

在终端的 Claude Code 会话里：

```text
/plugin install run-watch --marketplace GenLI3202/run-watch
```

也可以在命令行 `claude plugin install run-watch --marketplace GenLI3202/run-watch`。桌面版里 `/plugin` 不能用：点输入框旁的 **+**，选 **Plugins**，**Add marketplace** 填 `GenLI3202/run-watch`，再 **Add plugin**。

## 它读写什么

在本机记住你的看守列表。只读你指定的日志文件和进程（`ps -p`），macOS 上用 `osascript` 发通知。不向任何地方发送东西。

## 开发

```bash
claude plugin test .
```

## 许可

MIT，见 [LICENSE](LICENSE)。
