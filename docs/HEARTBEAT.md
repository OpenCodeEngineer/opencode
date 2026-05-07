# Scheduler + HEARTBEAT Design and Implementation

## Goal

Add a lightweight background scheduler to `opencode serve` that can:

1. Run recurring cron jobs.
2. Run workspace heartbeat prompts from `HEARTBEAT.md` on a configured interval.

The implementation reuses existing session/prompt pipelines and avoids a separate execution engine.

## Architecture Overview

```
opencode serve
  ├─ Session.startSweep()            (existing)
  └─ Scheduler.start()
      ├─ SchedulerRunner.start()     (cron jobs)
      └─ SchedulerHeartbeat.start()  (HEARTBEAT.md loop)
```

### Runtime Integration

- `packages/opencode/src/cli/cmd/serve.ts`
  - Starts scheduler inside `Instance.provide(...)` during serve startup.
  - Stops scheduler during shutdown.

- `packages/opencode/src/config/config.ts`
  - Adds `scheduler` config:
    - `enabled` (default `false`)
    - `heartbeat.enabled` (default `true`)
    - `heartbeat.interval` (default `"30m"`)
    - `maxConcurrent` (default `1`)

- `packages/opencode/src/session/instruction.ts`
  - Adds `HEARTBEAT.md` to instruction file discovery list.

## Scheduler Modules

### 1) Store (`src/scheduler/store.ts`)

Persistent storage for job definitions.

- File path: `${Global.Path.data}/scheduler/jobs.json`
- Atomic writes: temp file + rename
- Concurrency guard: `Lock.read` / `Lock.write`
- Cron validation: `croner` parser check

Stored job shape:

- `id`
- `schedule` (cron expression)
- `prompt` (text sent to agent)
- `enabled`
- `agent?`
- `model?` (`providerID`, `modelID`)
- `variant?`
- `created_at`
- `updated_at`
- `last_run_at?`

### 2) Runner (`src/scheduler/runner.ts`)

Executes cron jobs using a wake-on-next timer model.

- Uses a single `setTimeout` to sleep until the next due timestamp.
- Computes due times with `croner`.
- No fixed polling loop.
- Uses `maxConcurrent` from config.
- Reuses per-job sessions (`state.sessions` map) and calls `SessionPrompt.prompt(...)`.
- Marks run time via `SchedulerStore.touch(...)`.
- `notify()` triggers immediate recompute after job add/remove/enable/disable.

Important fix included:

- Timer wake now always refreshes and drains due jobs, even without an external `notify()` call.

### 3) Heartbeat (`src/scheduler/heartbeat.ts`)

Runs heartbeat prompts from workspace `HEARTBEAT.md`.

- Reads file from `path.join(Instance.worktree, "HEARTBEAT.md")`
- Missing file: skip
- Empty/whitespace file: skip
- Interval parsing supports `ms`, `s`, `m`, `h`, `d` (default `30m`)
- Uses dedicated heartbeat session (`Session.create({ title: "Heartbeat" })`)
- Executes via `SessionPrompt.prompt(...)`
- If latest text output is `HEARTBEAT_OK`, treated as explicit no-op completion

### 4) Scheduler API (`src/scheduler/index.ts`)

Top-level control:

- `Scheduler.start()`:
  - Reads config
  - Returns early when `scheduler.enabled` is `false`
  - Starts runner + heartbeat
- `Scheduler.stop()`:
  - Stops heartbeat then runner

## CLI and Tooling

### CLI Command (`src/cli/cmd/cron.ts`)

`opencode cron` subcommands:

- `add <schedule> <prompt>`
- `list`
- `remove <id>`
- `run <id>`
- `enable <id>`
- `disable <id>`

### Agent Tool (`src/tool/cron.ts`)

Tool id: `cron`

- Actions:
  - `add`
  - `list`
  - `remove`
- Calls `SchedulerRunner.notify()` after mutating actions.

## Tests

Added coverage:

- `test/scheduler/store.test.ts`
- `test/scheduler/runner.test.ts`
- `test/scheduler/heartbeat.test.ts`
- `test/scheduler/index.test.ts`
- `test/scheduler/serve-race.test.ts`
- `test/tool/cron.test.ts`

Key regression:

- `scheduler.runner > timer wake runs due jobs without notify`

This verifies due jobs run from timer wakeups even when `notify()` is not called.

## Operational Notes

- Scheduler and heartbeat loops run only in `serve` mode.
- Job definitions persist on disk; run history is limited to `last_run_at` per job.
- Heartbeat behavior is intentionally simple: non-empty file text becomes the heartbeat prompt.
