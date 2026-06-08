---
name: cursor-agent
description: >-
  Drive Cursor's CLI agent non-interactively via `cursor-agent -p` (headless
  print mode) to delegate coding work to a second, independent agent. Use this
  skill when the user wants a second opinion on a design or bug, an independent
  implementation plan, an independent code review of a diff or PR, a
  self-contained implementation task run headlessly, isolated work in a git
  worktree, or cross-checking your own work against another model. Also use when
  the user explicitly mentions "cursor-agent", "cursor agent", "cursor CLI", or
  asks to "have cursor plan / look at / build / review" something.

  Triggers: "ask cursor", "get a second opinion from cursor", "have cursor plan
  this", "have cursor review this", "run cursor-agent on X", "delegate this to
  cursor", "cursor-agent -p ...".
---

# cursor-agent (headless)

`cursor-agent -p` runs Cursor's coding agent **non-interactively** (headless print
mode): one prompt in, the agent works autonomously, output to stdout. It is a
separate coding agent from you — useful as an independent implementer, reviewer,
or second opinion. Treat it like delegating to a capable peer in another terminal.

Verify it is available and authenticated before relying on it:

```bash
cursor-agent --version          # e.g. 2026.05.28-a70ca7c
cursor-agent status             # "Logged in as ..." — else run `cursor-agent login`
```

Auth can also come from `CURSOR_API_KEY` or `--api-key <key>`. If missing, tell the
user — do not silently do the work yourself without saying so.

## Core invocation

```bash
# Headless: -p / --print is REQUIRED for non-interactive use.
# --trust is needed for the agent to act in the dir (safe here: ask can't write).
cursor-agent -p --trust --mode ask "summarize what this repo does"

# Pick output format and model
cursor-agent -p --trust --mode ask "explain the auth flow" --output-format text --model composer-2.5
```

The prompt is a positional argument. Without `-p`, cursor-agent launches its
interactive TUI — always pass `-p` when scripting. The directory must be trusted
(`--trust`) for the agent to do anything — even read-only `ask` runs.

## Safety & permissions — read this first

**Critical difference from codex:** cursor-agent has **no hard OS-level read-only
sandbox** like codex's `-s read-only`. In `-p` mode the agent "has access to all
tools, including write and shell" by default. Read-only is controlled by **mode**,
and the two modes are NOT equally safe (verified empirically):

| Mode | Write capability | Use for |
|------|------------------|---------|
| `--mode ask` | **Reliably read-only** — has no write/edit tools. Even with `--trust`/`--yolo` it refuses to edit (it prints the shell command instead). In testing it wrote **0/4** times when pushed. | analysis, second opinions, code review — anything that must not change files |
| `--mode plan` / `--plan` | **Soft read-only only.** Planning-focused, but it *retains* write tools and will make edits if pushed — it wrote **2/4** times when explicitly told to. Treat as "usually read-only," NOT a guarantee. | producing a plan you'll review — not as a write guard |
| (default mode) | Full write + shell | implementation |

So: **for a true read-only run, use `--mode ask`** (or run in a disposable
worktree). Do not rely on `--plan` to prevent edits.

Trust & approvals (these gate *whether* it can act, not the mode's read/write nature):

| Goal | How |
|------|-----|
| **Let it act at all** | the directory must be **trusted**. Pass `--trust` (headless only); trust then **persists per-directory**. An untrusted dir refuses *everything*, even `--mode ask`. |
| **Auto-approve commands** | `-f` / `--force` / `--yolo` (allow commands unless explicitly denied) |
| **OS sandbox toggle** | `--sandbox enabled` / `disabled` (overrides config) |
| **Isolate writes from your tree** | `-w` / `--worktree` (separate git worktree) |

Note `--trust`/`--yolo` do **not** turn `ask` into a writer — `ask` stayed
read-only in every test. But combining `--trust` with `--plan` does let plan's
soft mode make edits. **Default to `--mode ask`** for analysis; for write tasks use
default mode with `--trust`, and tell the user.

⚠️ **stdin is ignored.** Unlike codex, cursor-agent does **not** read a piped diff
or file from stdin (`git diff | cursor-agent -p "review this"` → it sees nothing).
Verified: it replied `NO_STDIN_RECEIVED`. Put context in the prompt, use `$(...)`
substitution, or have the agent run the command itself (e.g. "run `git diff`").

## Key flags

| Flag | Purpose |
|------|---------|
| `-p, --print` | headless / non-interactive (required for scripting) |
| `--output-format <fmt>` | `text` (answer only) \| `json` (final result object) \| `stream-json` (NDJSON events) |
| `--stream-partial-output` | stream text deltas (with `--print` + `stream-json`) |
| `--mode <mode>` | `ask` (reliably read-only Q&A) \| `plan` (planning; *soft* read-only — can still edit) |
| `--plan` | shorthand for `--mode plan` (soft read-only — see Safety) |
| `-m, --model <model>` | e.g. `sonnet-4`, `gpt-5`, `opus-4-8-thinking`; default is Composer 2.5. `--list-models` to see all |
| `--trust` | trust the workspace so it can edit/run (headless only) |
| `-f, --force` / `--yolo` | allow all commands unless explicitly denied |
| `--sandbox <mode>` | `enabled` \| `disabled` |
| `--resume [chatId]` / `--continue` | resume a specific / the previous session |
| `-w, --worktree [name]` | run in an isolated git worktree (`--worktree-base <branch>` to pick its base) |
| `--workspace <path>` | set the workspace directory |

## Workflows

### 1. Second opinion / pair programming
Get an independent take without letting it touch files — use `--mode ask`.

```bash
cursor-agent -p --trust --mode ask "We're choosing optimistic locking vs a queue for X. Trade-offs?"

# Cross-check a bug hypothesis (let the agent read the files itself)
cursor-agent -p --trust --mode ask "Why might test/worker.test.ts be flaky? Inspect src/worker.ts."
```

Use this to challenge your own conclusion, then reconcile the two answers for the
user — calling out where they agree or diverge.

### 2. Planning
Cursor has a **plan mode** that investigates and proposes an implementation plan.
It's planning-focused but only *soft* read-only (it can still edit if pushed — see
Safety), so use it to get a plan, not as a write guard.

```bash
cursor-agent -p --trust --plan "Plan how to add OAuth login: files to touch, ordered steps, risks, tests. Do not edit anything."
```

If you need a *hard* guarantee it won't touch files while planning, use `--mode ask`
instead of `--plan` (ask has no write tools) and just ask it to produce the plan.

Plan-as-second-opinion: have cursor plan independently and reconcile with your own.
Plan→execute: feed the plan into a fresh write-enabled run (don't rely on resume to
flip modes):

```bash
cursor-agent -p --trust "Implement this plan step by step: $(cat plan.md)"
```

### 3. Code review
There's no dedicated review subcommand. Use **`--mode ask`** (reliably read-only)
and have the agent inspect the diff itself — it can run `git diff` in ask mode.
Remember stdin is ignored, so tell it to run git rather than piping the diff in:

```bash
cursor-agent -p --trust --mode ask "Review the uncommitted changes for correctness bugs and risky edge cases. Run git diff yourself. Reference file:line and quote each buggy line."

# Or against a base branch:
cursor-agent -p --trust --mode ask "Review the diff between HEAD and origin/main. Run the git command yourself. Flag bugs by file:line."
```

Verified: on a repo with a planted operator bug + an unguarded division, composer-2.5
in ask mode ran `git diff` and reported both, with a file:line table. Relay findings
to the user; offer to fix, but don't auto-apply unless asked.

### 4. Delegated implementation (headless)
Hand off a self-contained task. Needs `--trust` (and `--yolo` if it must run build/
test commands unattended).

```bash
cursor-agent -p --trust "Add input validation to the /signup handler and a unit test for it."
```

Then review what it changed (`git diff`) before trusting it — inspect it like any
other diff. For risky tasks, isolate the changes in a worktree (workflow 7).

### 5. Structured / scriptable output
`--output-format json` emits a single final result object you can parse:

```bash
cursor-agent -p --trust --mode ask "One-line summary of this repo" --output-format json | jq -r .result
```

The JSON object includes `result` (the answer), `session_id`, and `usage`. Verified:
`jq -r .result` cleanly extracts just the answer.

### 6. Multi-turn (resume / continue)
Continue a prior session with its context retained.

```bash
cursor-agent -p --continue "now also add the migration"
cursor-agent -p --resume <chatId> "address the review comments"
cursor-agent ls                 # list resumable sessions
ID=$(cursor-agent create-chat)  # pre-create a session id for scripting
```

### 7. Isolated / parallel work (git worktree)
Run a delegated task in a separate worktree so it never touches your working tree —
ideal for background or parallel work.

```bash
cursor-agent -p --trust -w feature-x "Implement feature X end to end."
# Lands in ~/.cursor/worktrees/<repo>/feature-x ; review and merge when done.
```

For long tasks, launch it in the background (in this harness, `run_in_background:
true`) and capture output to a file.

## Output / event format

- `--output-format text` → just the final answer text.
- `--output-format json` → one final object: `{"type":"result","result":"...","session_id":"...","usage":{...}}`.
  Extract the answer with `| jq -r .result`.
- `--output-format stream-json` → NDJSON event stream (verified types): `system`
  (init: model, cwd, `permissionMode`), `user`, `assistant`, `text`/`word`
  (incremental text), `tool_call` (one per file edit / shell command), then `result`.
  Add `--stream-partial-output` for finer text deltas.

```bash
# Watch progress as a stream
cursor-agent -p "build the feature" --trust --output-format stream-json
```

## Context files

Cursor reads `AGENTS.md` and `.cursor/rules/*` for project/user conventions. For a
one-off run that should follow specific rules without editing those files, put the
rules directly in the prompt. `cursor-agent generate-rule` scaffolds a new rule.

## Gotchas

- **No hard read-only sandbox.** Unlike codex's `-s read-only`, safety is by mode.
  `--mode ask` is reliably read-only (no write tools); **`--plan` is only soft
  read-only and wrote 2/4 times when pushed** — don't trust it as a write guard.
- **stdin is ignored** — piping `git diff` in does nothing. Embed context in the
  prompt or have the agent run the command itself.
- **Untrusted dirs refuse to act** — pass `--trust` (trust persists per-dir).
  `--trust`/`--yolo` don't make `ask` write, but they do let `--plan` edit.
- **`-p` is mandatory** for scripting — without it you get the interactive TUI.
- **Review before trusting writes** — inspect `git diff`; consider `-w` worktree
  isolation for risky tasks.
- **It's a different model** (Cursor's Composer by default, or `--model sonnet-4`/
  `gpt-5`/etc.) — when used as a second opinion, surface both views rather than
  assuming cursor is right.
- **Don't leak secrets** into prompts sent to an external model.
