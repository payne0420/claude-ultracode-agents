---
name: codex-exec
description: >-
  Drive OpenAI's Codex CLI non-interactively via `codex exec` to delegate coding
  work to a second, independent agent. Use this skill when the user wants a second
  opinion on a design or bug, an independent implementation plan, an independent
  code review of a diff or PR, a self-contained implementation task run headlessly,
  parallel/background work on a sub-task, or cross-checking your own work against
  another model. Also use when the user explicitly mentions "codex", "codex exec",
  "codex review", or asks to "have codex plan / look at / build / review" something.

  Triggers: "ask codex", "get a second opinion from codex", "have codex plan this",
  "have codex review this", "run codex on X", "delegate this to codex",
  "cross-check with codex", "codex exec ...".
---

# Codex exec

`codex exec` runs OpenAI's Codex CLI **non-interactively** (headless): one prompt
in, agent works autonomously inside a sandbox, final message out. It is a separate
coding agent from you — useful as an independent implementer, reviewer, or
second opinion. Treat it like delegating to a capable peer in another terminal.

Verify it is available before relying on it:

```bash
codex --version          # e.g. codex-cli 0.135.0
```

If missing, tell the user to install it (`npm i -g @openai/codex` or via their
package manager) — do not silently fall back to doing the work yourself without
saying so.

## Core invocation

```bash
# Prompt as an argument
codex exec "summarize what this repo does" -s read-only
# ...but when launching non-interactively/in the background, append `< /dev/null`
# or codex blocks forever reading stdin (see Gotchas).

# Prompt from stdin (good for long/multi-line prompts or piping context)
echo "explain the auth flow" | codex exec -s read-only
cat bug-report.md | codex exec "fix the bug described below" -s workspace-write

# Pipe context AND give an instruction — stdin is appended as a <stdin> block
git diff | codex exec "review this diff for correctness bugs" -s read-only
```

`codex e` is an alias for `codex exec`. Codex must run **inside a git repo** by
default; add `--skip-git-repo-check` to run elsewhere.

The agent's final message prints to stdout (after a header + the live action log).
For just the answer, capture it with `-o` or parse `--json` (see below).

## Sandbox & safety — choose deliberately

Sandbox is the single most important flag. In exec mode there is **no human to
approve actions**, so the sandbox is the only guardrail.

| `-s` / `--sandbox`     | Codex can…                                              | Use for |
|------------------------|---------------------------------------------------------|---------|
| `read-only`            | read files, run read-only commands; **no writes, no network** | review, analysis, second opinions, Q&A |
| `workspace-write`      | read + write inside the workspace (and `--add-dir` paths); network off by default | implementation, refactors, fixing tests |
| `danger-full-access`   | unrestricted writes + network                           | only when explicitly required and authorized |

**This is a HARD OS-level sandbox, not a behavioral hint** (verified). In
`read-only`, a model told to write a file tried both shell redirection *and* Python
and the OS blocked both with `PermissionError: [Errno 1] Operation not permitted` —
it wrote **0/4** times across trials. Network is genuinely off too, and it's the
sandbox — not the model — enforcing it: `curl https://example.com` returns exit 6
(`Could not resolve host`) under both `read-only` and `workspace-write`, but the same
command under `danger-full-access` succeeds with HTTP 200 (control test, identical
across `gpt-5.5` and `gpt-5.3-codex-spark`). This is a stronger guarantee than
cursor's soft `--plan` (which wrote 2/4) — codex read-only *cannot* write or reach
the network even if the model tries.

**Default to `read-only`.** Escalate to `workspace-write` only when the task
genuinely needs to change files, and tell the user when you do. Avoid
`danger-full-access` and `--dangerously-bypass-approvals-and-sandbox` unless the
user explicitly asks and understands the risk (e.g. the environment is already
externally sandboxed). If a task needs network (e.g. installing deps), that requires
`danger-full-access` or an explicit `-c` network override — plain `workspace-write`
will fail offline.

Scope writes precisely:

```bash
codex exec "refactor the parser" -s workspace-write -C ./packages/core --add-dir ./shared
```

- `-C, --cd <DIR>` — working root for the agent
- `--add-dir <DIR>` — extra writable directory alongside the workspace

## Key flags

| Flag | Purpose |
|------|---------|
| `-s, --sandbox <mode>` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `-m, --model <model>` | pick the model, e.g. `gpt-5.3-codex-spark` (light/fast) or a heavier codex model; omit to use config default |
| `-c key=value` | override any config value (TOML path), e.g. `-c model_reasoning_effort=low` |
| `-i, --image <file>` | attach screenshot(s) / images to the prompt |
| `-o, --output-last-message <file>` | write **only** the final message to a file |
| `--json` | stream events as JSONL on stdout (for scripting) |
| `--output-schema <file>` | force the final message to match a JSON Schema |
| `-C, --cd <dir>` / `--add-dir <dir>` | set / extend the working root |
| `--skip-git-repo-check` | allow running outside a git repo |
| `--ephemeral` | don't persist the session to disk |

## Model & cost control

`codex exec` uses the model and `model_reasoning_effort` from `~/.codex/config.toml`
by default — which may be set high (e.g. `xhigh`) and burn a lot of tokens on simple
delegations. Two levers to keep cost down:

```bash
# Lighter model for quick/cheap tasks
codex exec "..." -s read-only -m gpt-5.3-codex-spark

# Or lower the reasoning effort per-run (independent of model)
codex exec "..." -s read-only -c model_reasoning_effort=low
```

Reserve the heavy default model + high effort for genuinely hard reasoning (deep
review, tricky bugs, architecture). For a one-line summary or a quick second
opinion, a light model at low effort is plenty.

## Workflows

### 1. Second opinion / pair programming
Get an independent take without letting it touch files. Feed it the relevant
context and ask a sharp question.

```bash
# Cross-check a design decision
codex exec "We're choosing between optimistic locking and a queue for X. Trade-offs?" -s read-only

# Independent debugging hypothesis — pipe in the failing context
{ echo "Test fails intermittently. Code + test below:"; cat src/worker.ts test/worker.test.ts; } \
  | codex exec "What race condition could cause this flaky test?" -s read-only
```

Use this to challenge your own conclusion: have codex analyze the same problem
independently, then reconcile the two answers for the user, calling out where they
agree or disagree.

### 2. Code review
Codex has a dedicated reviewer that returns prioritized, file:line-anchored findings.

```bash
codex review --uncommitted          # staged + unstaged + untracked
codex review --base main            # diff against a base branch
codex review --commit <sha>         # a single commit
codex review "focus on security and error handling"   # custom instructions

# Equivalent under exec:
codex exec review --uncommitted
```

Findings come with priority tags (e.g. `[P2]`) and `path:line` references. Verified:
the reviewer runs `git diff` itself and reports planted bugs by file:line (works
even with a light model like `gpt-5.3-codex-spark`). Relay findings to the user;
offer to fix, but don't auto-apply unless asked.

### 3. Planning
Headless `codex exec` has **no formal plan mode** (the `plan_mode_reasoning_effort`
config applies only to the interactive TUI). You plan by running **`read-only`** and
asking codex to produce a plan — the sandbox guarantees it investigates but changes
nothing.

```bash
# Investigate the codebase and produce an ordered implementation plan — no edits
codex exec "Plan how to add OAuth login. List the files to touch, the steps in
order, risks, and what to test. Do NOT write any code." -s read-only -o /tmp/plan.md
```

Bump reasoning effort for hard planning: `-c model_reasoning_effort=high`.

Get a **machine-readable plan** by combining with `--output-schema` (see workflow 5):

```bash
cat > /tmp/plan-schema.json <<'EOF'
{ "type":"object",
  "properties": {
    "steps": { "type":"array","items":{
      "type":"object",
      "properties": { "title":{"type":"string"}, "files":{"type":"array","items":{"type":"string"}}, "rationale":{"type":"string"} },
      "required":["title","files","rationale"], "additionalProperties": false } },
    "risks": { "type":"array","items":{"type":"string"} } },
  "required":["steps","risks"], "additionalProperties": false }
EOF
codex exec "Plan the migration from REST to gRPC for the orders service." \
  -s read-only --output-schema /tmp/plan-schema.json -o /tmp/plan.json
```

**Plan-as-second-opinion:** have codex plan independently, then reconcile it with
your own plan for the user — surfacing where the two approaches diverge.

**Plan → execute handoff:** a read-only planning session **cannot** be resumed into
one that writes (`resume` inherits the original sandbox). So don't resume the plan —
feed it into a fresh `workspace-write` run:

```bash
codex exec "Implement this plan step by step. Stop after each step." \
  -s workspace-write < /tmp/plan.md
```

### 4. Delegated implementation (headless)
Hand off a self-contained task and capture the result. Requires `workspace-write`.

```bash
codex exec "Add input validation to the /signup handler and a unit test for it" \
  -s workspace-write -o /tmp/codex-summary.txt
```

Then review what it changed (`git diff`) before trusting it. Codex's changes are
just edits in the working tree — inspect them like any other diff.

### 5. Structured output (for programmatic use)
Force machine-readable output with a JSON Schema. The final message becomes JSON
matching the schema.

```bash
cat > /tmp/schema.json <<'EOF'
{ "type":"object",
  "properties": { "risk":{"type":"string"}, "files":{"type":"array","items":{"type":"string"}} },
  "required":["risk","files"], "additionalProperties": false }
EOF
echo "Assess the risk of this change and list affected files" \
  | codex exec -s read-only --output-schema /tmp/schema.json -o /tmp/out.json
```

### 6. Multi-turn (resume)
Continue a prior session with its full context retained.

```bash
codex exec resume --last "now also add the migration"   # most recent session
codex exec resume <session-id> "address the review comments"
```

Note: `resume` **inherits the original session's sandbox** — it does not accept
`-s`. The session id is printed in the header and as `thread_id` in JSON output.

### 7. Parallel / background work
For long delegated tasks, run codex in the background and keep working. Capture
output to a file and check it when done.

```bash
codex exec "port the test suite from mocha to vitest" -s workspace-write \
  -o /tmp/codex-port.txt < /dev/null
```

**Always close stdin with `< /dev/null`** (or pipe the prompt in) on the arg-prompt
form when running non-interactively. Even with the prompt as an argument, codex still
reads additional input from stdin to append as a `<stdin>` block; a detached/background
launch has no TTY and no EOF, so that read **blocks forever** (see Gotchas). With a
long prompt in a file, piping it in does double duty — supplies the prompt *and* closes
stdin:

```bash
cat /tmp/codex-prompt.txt | codex exec -s read-only -o /tmp/codex-out.txt
```

(In this harness, launch it with `run_in_background: true` and read the output file
when notified.)

## JSON event stream

With `--json`, stdout is JSONL — one event per line. Useful for capturing the
answer or monitoring progress in scripts.

Event shape:
- `{"type":"thread.started","thread_id":"..."}`
- `{"type":"turn.started"}`
- `{"type":"item.started" | "item.completed","item":{...}}` — item `type` is one of
  `agent_message` (the model's text), `command_execution`, `file_change`, `reasoning`
- `{"type":"turn.completed","usage":{...}}`

Extract just the final answer:

```bash
echo "one-line summary of this repo" | codex exec -s read-only --json \
  | grep '"type":"item.completed"' | grep '"agent_message"' | tail -1
# ...or simply use -o /path and read the file.
```

## Context files (AGENTS.md)

Codex reads `AGENTS.md` for project/user instructions, analogous to `CLAUDE.md`:
`~/.codex/AGENTS.md` (global) and `AGENTS.md` in the repo/working dir (project).
When you need codex to follow specific conventions for a one-off run without
editing those files, put the rules directly in the prompt or use `-c` overrides.

## Gotchas

- **Sandbox is the guardrail, and it's hard.** No human approves actions in exec
  mode — pick the narrowest `-s` that works. `read-only` is OS-enforced: writes hit
  `Operation not permitted` even if the model tries (verified 0/4). Network is off in
  both `read-only` and `workspace-write` (`curl` → exit 6); tasks needing the network
  must use `danger-full-access` or a `-c` network override.
- **Mind the default reasoning effort/model** — config may default to a heavy model
  at high effort. Use `-m gpt-5.3-codex-spark` / `-c model_reasoning_effort=low` for
  cheap tasks (see Model & cost control).
- **Non-interactive launches hang on stdin unless you close it.** When running
  `codex exec` in the background / headless (no controlling TTY) with the prompt as a
  command-line **argument**, you MUST redirect stdin from `/dev/null` (`< /dev/null`)
  or pipe the prompt in. Codex always tries to read additional input from stdin to
  append as a `<stdin>` block; a detached fd never sends EOF, so the read **blocks
  forever**. Diagnostic signature: stderr shows only `Reading additional input from
  stdin...`, the `-o` output file is never created, and the process stays alive
  (doesn't error or exit) until killed. Piping the prompt (`cat prompt | codex exec
  …`) avoids it because the pipe closes and sends EOF. Interactive terminals don't hit
  this — a TTY stdin behaves differently. (Observed: codex-cli 0.136.0, macOS,
  `run_in_background: true`.)
- **Git repo required** unless you pass `--skip-git-repo-check`.
- **Review before trusting writes.** After a `workspace-write` run, inspect
  `git diff` — codex acts autonomously and may make changes you didn't intend.
- **`resume` ignores `-s`** — sandbox is fixed by the original session.
- **It's a different model.** Disagreement with you is the point when used as a
  second opinion; surface both views rather than assuming codex is right or wrong.
- **Don't leak secrets** into prompts piped to an external model.
