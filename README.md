# run-watch

[简体中文](README.zh-CN.md)

A mod for the Claude desktop app that **watches long runs from their log files, with no model calls**: progress and ETA, and a notice when the run finishes, fails or stops writing. Training jobs, simulations, builds: start them, close the laptop lid on your attention, and be told.

## What it does

- **`/watch ./run.log --pid 4242`** starts watching. Options: `[name]`, `--pid N`, `--done REGEX`, `--fail REGEX`, `--progress REGEX`, `--stall 30m`. `/watch list`, `/watch stop <#>`, `/watch clear`.
- **Progress and ETA** from the last `n%` or `a/b` in the log tail (or your own `--progress` pattern, with one or two capture groups).
- **Finished** when the `--done` pattern appears, the process (`--pid`) ends, or progress reaches 100%. **Failed** on the default patterns (Traceback, FATAL, Segmentation fault, Killed, CUDA out of memory, MemoryError, OutOfMemory) or your `--fail`; also if the process ends before the finish line. **Stalled** when the log stops growing for 30 minutes (`--stall`).
- **A notice you will see**: a toast, and on macOS a system notification.
- Polls once a minute, reads only the last 16 KB of each log, up to 12 watches at a time.

## Install

In a Claude Code session in a terminal:

```text
/plugin install run-watch --marketplace GenLI3202/run-watch
```

Or from a shell: `claude plugin install run-watch --marketplace GenLI3202/run-watch`. In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `GenLI3202/run-watch`, then **Add plugin**.

## What it reads and writes

Remembers its watch list locally. It reads the log files and process list you point it at (`ps -p`), and on macOS runs `osascript` for notifications. Nothing is sent anywhere.

## Develop

```bash
claude plugin test .
```

## License

MIT, see [LICENSE](LICENSE).
