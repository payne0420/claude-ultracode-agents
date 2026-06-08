---
name: ultracode-external-agents
description: >-
  Author ultracode workflows whose agent() steps are executed by an EXTERNAL
  coding CLI — OpenAI Codex, Cursor, or opencode — instead of (or alongside)
  regular Claude subagents. Use this when building a Workflow and you want some
  or all of its agents to run on a different model/provider: multi-model review
  or design panels, an independent second opinion inside a pipeline, off-budget
  heavy implementation, or genuine model diversity in a fan-out. Explains the
  bridge (a thin Claude adapter shells out to the CLI), gives copy-paste
  delegation helpers, per-backend invocation recipes, structured-output mapping,
  worktree isolation for parallel writes, and a full runnable example workflow.
  Applies only inside an ultracode/Workflow authoring turn — the Workflow tool
  must be active; if it is not, this skill has nothing to do and should not be
  selected.

  Triggers: "use codex/cursor/opencode in a workflow", "ultracode with codex",
  "run my workflow on GPT/Composer instead of Claude", "multi-model workflow",
  "delegate workflow agents to an external CLI", "multi-model review panel",
  "external agents in a workflow", "fan out to different models".
---

# Ultracode workflows with external agents (codex / cursor / opencode)

This skill is for **authoring `Workflow` scripts** in which some `agent()` steps
run on an external coding CLI (`codex exec`, `cursor-agent -p`, `opencode run`)
rather than on Claude. The payoff is real **model diversity**: a review or design
panel where each member is a different model, an independent second opinion inside
a deterministic pipeline, or heavy implementation done by another agent.

> Prerequisite: the workflow turn must be opted into ultracode / the `Workflow`
> tool (the user says "ultracode", or asks for a workflow). This skill shapes
> *what runs inside* that workflow.

## How ultracode workflows actually run (the bit that matters here)

A workflow is a JavaScript orchestration script the `Workflow` tool runs in the
background. Its building blocks:

- `agent(prompt, opts)` — spawn **one Claude subagent**; returns its final text,
  or a validated object if you pass `opts.schema`.
- `parallel(thunks)` — barrier: run all concurrently, await all.
- `pipeline(items, ...stages)` — per-item staged, no barrier (the default).
- `phase()`, `log()`, `args`, `budget`, `workflow()`.

Two hard facts decide the whole design:

1. **The script can't shell out.** Workflow scripts are sandboxed JS — *no
   filesystem, no `child_process`, no Node APIs*. So the script cannot call
   `codex`/`cursor-agent`/`opencode` directly.
2. **`agent()` is always Claude.** `opts.agentType` only selects among
   *Claude-based* agent definitions (the same registry as the Agent tool —
   `general-purpose`, `Explore`, custom `.claude/agents/*.md`). You **cannot**
   register the codex/cursor/opencode binary as an `agentType`.

### The bridge

The simplest, most portable bridge is to spawn a **thin Claude subagent whose
entire job is to run the external CLI via its Bash tool and relay the result**:

```
workflow script ──agent(delegate(cmd))──▶ Claude adapter ──Bash──▶ codex/cursor/opencode
       (orchestration)                    (runs 1 command,            (does the real
                                           relays output)              reasoning/coding)
```

The Claude adapter does almost no thinking — it runs one command and returns the
external model's output (verbatim, or mapped into your `schema`). Everything
downstream (`pipeline`, `parallel`, dedup, synthesis) works unchanged.

> **One alternative, codex-only.** Codex can run *as* an MCP server (`codex
> mcp-server`, stdio), so instead of the Bash adapter you could define a custom
> `agentType` (`.claude/agents/*.md`) that registers it via the agent's
> `mcpServers` frontmatter and have `agent()` call it as a structured MCP tool —
> no Bash, no verbatim relay. It is still a Claude subagent (so "agentType is
> always Claude" holds), just a cleaner I/O surface. Trade-offs: server
> lifecycle/auth, and it only works for codex — `cursor-agent mcp` and `opencode
> mcp` only *manage* servers those CLIs consume (opencode's `serve`/`acp` are its
> own HTTP/ACP APIs, not MCP), so neither exposes itself as an MCP server. The
> Bash adapter below is the one pattern that works uniformly across all three,
> which is why this skill standardizes on it.

## The delegation pattern (minimal)

Inline two helpers + one builder into your script body (full set in
`templates/delegate.js`):

```js
function sh(s){ return "'" + String(s).replace(/'/g,"'\\''") + "'"; }
function delegate(cmd){ return [
  "You are a thin adapter around another coding agent. Run this ONE shell command",
  "with the Bash tool (long timeout ~600000 ms; it may take minutes — don't interrupt):",
  "", "```bash", cmd, "```", "",
  "The CLI prints a progress log then the agent's FINAL message. If asked for",
  "structured output, fill the fields from it; otherwise return ONLY that final",
  "message verbatim. On non-zero exit, return stderr + the exit code.",
].join("\n"); }
function codexCmd(p,o={}){ return `codex exec ${sh(p)} -s ${o.mode||"read-only"} -m ${o.model||"gpt-5.5"} -c model_reasoning_effort=${o.effort||"xhigh"} < /dev/null`; }
```

Then call it like any other workflow agent:

```js
const codexReview = await agent(
  delegate(codexCmd("Review the uncommitted diff for bugs. Run git diff yourself.")),
  { label: 'codex', phase: 'Review', agentType: 'general-purpose' }
);
```

**Always give delegation wrappers `agentType: 'general-purpose'`** — it is
guaranteed to have the Bash tool (the default workflow subagent may be more
restricted).

> **Tip — load the backend's own skill first.** This skill carries only the
> workflow-relevant core of each CLI. When you delegate anything non-trivial
> (write mode, sandbox/permission nuance, structured/JSON output, multi-turn
> resume, background runs, auth/setup), invoke the matching skill with the Skill
> tool — **`codex-exec`**, **`cursor-agent`**, or **`opencode`** — to pull its
> complete flag + gotcha reference into context, then build the command. Those
> skills are the source of truth; the cheat-sheet below is just the highlights.

## Structured output across the bridge

Pass `opts.schema` exactly as you would for a Claude agent. The adapter runs the
CLI, then maps the external model's answer into your fields — so external agents
drop straight into structured `pipeline()`/`parallel()` stages:

```js
const FINDINGS = { type:'object', additionalProperties:false,
  required:['findings'], properties:{ findings:{ type:'array', items:{
    type:'object', additionalProperties:false, required:['file','line','issue'],
    properties:{ file:{type:'string'}, line:{type:'integer'}, issue:{type:'string'} } } } } };

const r = await agent(delegate(codexCmd(REVIEW)),
  { schema: FINDINGS, label:'codex', agentType:'general-purpose' });
// r.findings is a validated array, regardless of how codex formatted its text.
```

For deterministic extraction without the model in the loop, you can instead make
the CLI emit JSON and pipe it through `jq` in the command itself (`codex --json`,
`cursor-agent --output-format json | jq -r .result`, `opencode --format json |
jq -rs '...'`) — but the schema-mapping path above is simpler and usually enough.

## Per-backend cheat-sheet

Pick the backend per step. This table is only the highlights — for depth on any
one, **load its dedicated skill with the Skill tool** (`codex-exec`,
`cursor-agent`, `opencode`); they're the source of truth for flags and gotchas.

| | **codex** (`codex exec`) | **cursor** (`cursor-agent -p`) | **opencode** (`opencode run`) |
|---|---|---|---|
| Read-only / review | `-s read-only` (**OS-hard**: no writes, no net) | `--mode ask` (reliably read-only) | `--agent plan` (hard read-only) |
| Write / implement | `-s workspace-write` | default mode `--trust` (+`--yolo` for cmds) | `--agent build` (writes in-workspace, no flag) |
| Pick model | `-m gpt-5.5` *(helper default)*; `-m gpt-5.3-codex-spark` (light) | `--model composer-2.5` *(helper default)*; `*-thinking` variants for more reasoning | `-m opencode-go/deepseek-v4-pro` *(helper default; ids machine-specific)* |
| Effort | `-c model_reasoning_effort=xhigh` *(helper default)*; `…=low` for cheap | **none** — no effort flag; reasoning is baked into the model (`*-thinking`) | `--variant max` *(helper default)*; `minimal`/`high` otherwise |
| Clean machine output | `--json` / `-o file` / `--output-schema` | `--output-format json \| jq -r .result` | `--format json \| jq -rs 'map(select(.type=="text").part.text)\|join("")'` |
| **Must-know gotcha** | **close stdin** (`< /dev/null`) or it hangs forever; needs a git repo (`--skip-git-repo-check` otherwise) | **`-p` + `--trust` mandatory**; **stdin is ignored** — embed context or tell it to run git; `--plan` is only *soft* read-only (**observed editing when pushed** — vendor `--help` wrongly labels it "no edits"); use `--mode ask` for a hard guard, but note ask-mode may **block shell/`git`** in some envs (it falls back to reading the working tree) — for a diff review, prefer piping the diff in over telling it to run `git diff` | **pin `-m`** or you get a router/free model — and there is **no universal model id** (`opencode models` differs per machine; don't assume `anthropic/claude-opus-4-8` exists); headless **auto-rejects** `ask`-perms (doesn't hang) |

Default to **read-only** modes for panels/reviews/second-opinions; escalate to
write modes only for delegated implementation, and say so.

**Helper defaults (in `templates/delegate.js`)** are tuned for deep work, so each
backend is a different model at high effort: codex `gpt-5.5` @ `xhigh`, cursor
`composer-2.5` (no effort knob), opencode `opencode-go/deepseek-v4-pro` @
`--variant max`. These are heavy/expensive — override per call for cheap runs
(e.g. `codexCmd(p, { model:'gpt-5.3-codex-spark', effort:'low' })`). The opencode
id is machine-specific; run `opencode models` to confirm or repoint it.

## Raw LLM endpoint backend (`llm-endpoint`)

A fourth, different kind of backend: a **raw OpenAI-/Anthropic-compatible HTTP
endpoint** (the companion **`llm-endpoint`** skill), for hitting an arbitrary
model behind a gateway/router/proxy. Key difference: **it is a single model call,
not an agent** — it can't run `git diff`, read files, or explore the repo. So you
must **feed it the context** (put it in the prompt, or pipe it in). The base URL
and API key come from local config (`~/.config/llm-endpoint/env`) — never
hardcoded, so workflow scripts that use it stay safe to commit.

`delegate.js` ships `llmCmd()`:

```js
// pure prompt (context already inside it)
agent(delegate(llmCmd("Assess this design: …", { model: 'provider/model' })),
      { agentType:'general-purpose', label:'llm' })

// review the diff — gather context via opts.pipe (it isn't an agent, so YOU pipe it)
agent(delegate(llmCmd("Review this diff for bugs; cite file:line.", { pipe: 'git diff; git diff --staged' })),
      { agentType:'general-purpose', label:'llm', phase:'Panel' })
```

`model`/`kind` (`chat` → `/chat/completions`, `messages` → `/messages`) fall back
to the config defaults if omitted. Use this backend when you want a specific model
that's only reachable through the gateway, or a cheap/fast extra opinion; reach
for the CLI backends instead when the step needs real repo exploration or edits.
The example workflow includes it as an optional reviewer (it pipes the diff in).

> **Note (verified live):** because you pipe the raw `git diff` in, the model's
> line references are **diff-relative** — they can be offset from the real file
> line numbers (e.g. by the hunk header + context lines). If you need
> file-accurate `file:line` refs, also include the file contents, or let a CLI
> backend (which reads the file itself) own the line-numbered findings.

## Writes & isolation (parallel implementation fan-out)

For a panel that only *reads* (review, plan, second opinion) no isolation is
needed — run them all in `parallel()`. If multiple external agents **write files
concurrently** they will clobber each other. Two ways to isolate:

- **Workflow-level:** give the `agent()` call `isolation: 'worktree'` — the Claude
  adapter (and thus the CLI it launches) runs in its own git worktree.
  ```js
  agent(delegate(codexCmd(task, { mode:'workspace-write' })),
        { isolation: 'worktree', agentType:'general-purpose', label:'impl' })
  ```
  **Base ref matters.** A `'worktree'` isolation worktree branches from whatever
  `worktree.baseRef` is set to — and the default is `fresh`, which branches from
  `origin/<default-branch>` (a clean, *pushed* checkout). Your uncommitted changes
  and unpushed commits are **not** carried in. So a write fan-out that must build
  on the *current* state needs `worktree.baseRef: 'head'` in settings (branches
  from local HEAD); otherwise the agents silently work against `origin/<default>`.
  And the current *diff* is never carried into an isolation worktree at all — so a
  read-only review of the **current** changes must run *without* `isolation`
  (as the example workflow does: it omits `isolation` and tells each reviewer to
  run `git diff` in the live tree).
- **CLI-level:** `cursor-agent -w <name>` (own worktree) or codex `-C <dir>
  --add-dir <dir>` to scope writes.

**Parallel write fan-out** — give each agent its own worktree so they can't
collide (without `isolation`, parallel writers in the same tree corrupt each
other's edits):

```js
const tasks = [
  "Add input validation to the /signup handler + a unit test.",
  "Add a rate limiter to the /login handler + a unit test.",
  "Convert the config loader to async + update its callers.",
];
const results = await parallel(tasks.map((t, i) => () =>
  agent(delegate(codexCmd(t, { mode:'workspace-write' })),       // or cursorCmd(t,{mode:null}) / opencodeCmd(t,{agent:'build'})
        { isolation:'worktree', agentType:'general-purpose', label:`impl:${i}` })
));
// each change lands in its own worktree/branch — review and merge them separately.
```

Mix backends across the fan-out for diversity, and remember the base-ref note
above (set `worktree.baseRef: 'head'` if each agent must build on local work).

Each external agent's edits are just changes in a working tree — review the diff
before trusting them, same as any delegated work.

## Budget & cost

`budget.spent()` counts only **Claude** output tokens; the external CLI's own
compute is billed to your Codex / Cursor / opencode account and does not count
against the workflow budget. But mind the **relay**: the adapter returns the
external model's final message *verbatim*, so a large external answer is paid for
as Claude **output** tokens once (the adapter producing it) and again as Claude
**input** tokens in any downstream reconcile/synthesis step that consumes it. The
external *compute* is off-budget; the relayed *text* is squarely on the Claude
budget on both sides. For big outputs, don't relay raw — have the adapter
extract/summarize via `schema` (so only the structured fields cross the bridge),
or make the CLI write to a file (codex `-o` / `--output-schema`, cursor
`--output-format json | jq -r .result`, opencode `--format json`) and pass the
path instead of the contents. Also mind the *external* cost levers: codex may
default to a heavy model at high effort (`-m gpt-5.3-codex-spark` /
`-c model_reasoning_effort=low` for cheap runs); pin opencode's model so you don't
silently hit an expensive one.

## Long-running tasks

The adapter's Bash call blocks that one subagent (other workflow agents proceed
concurrently). Two limits matter, and they're independent:

- **Bash max timeout** is 600000 ms (10 min) — the wrapper prompt sets a long
  timeout, so a blocking call dies here at 10 min.
- **Subagent stall watchdog** — a subagent that produces no output mid-stream
  fails after ~10 min. A *silent* poll loop emits no tokens and can trip this even
  while the underlying CLI is still working.

So don't have the adapter block-and-wait or run a silent `while …; do sleep;
done` loop (foreground `sleep` is blocked in the Bash tool anyway, so that loop
isn't viable here). For jobs that may exceed ~10 min, launch the CLI with
`run_in_background: true` writing its output to a file (codex `-o /tmp/out.txt`,
or redirect stdout), let the Bash call return immediately, and read the file when
the background process exits and notifies you — the same long-task pattern the
`codex-exec` / `cursor-agent` / `opencode` skills use. Or split the work into
smaller delegated steps so no single call approaches the limit.

## Full example

`templates/review-panel.workflow.js` is a complete, runnable workflow: it
preflights which CLIs are installed, runs a **codex + cursor + opencode** review
of the current diff in parallel (each a different model, all read-only), then has
Claude reconcile them into one deduplicated report where cross-reviewer agreement
signals confidence. Run it with `Workflow({ scriptPath:
"~/.claude/skills/ultracode-external-agents/templates/review-panel.workflow.js" })`,
or adapt it: swap `REVIEW` for a design question (panel), or switch the roster to
write-mode + worktree isolation for a parallel implementation fan-out (mind the
worktree base ref — see *Writes & isolation*).

## When to use external agents in a workflow — and when not

**Use them for:** model diversity (panels, juries, independent second opinions),
cross-checking Claude's own conclusion against another model, off-budget heavy
implementation, or leaning on a provider you trust for a specific domain.

**Keep Claude (plain `agent()`) for:** the orchestration glue — dedup, synthesis,
reconciliation, schema shaping, routing — and any step that needs the workflow's
own context. A good workflow usually *mixes* both: external agents generate
diverse raw work; Claude agents structure and reconcile it.

## Choosing the roster (per task) — Claude decides

**The roster is a decision you (Claude) make per task, not a fixed default.** When
you author or adapt a workflow from this skill, pick which backends to include —
and how many — based on what the job needs. Don't reflexively use all three; don't
reflexively use one. Match the team to the task:

- **Want disagreement / coverage** (code review, design choice, "is this
  correct?") → include **all installed** backends. Different models catch
  different things — that's the entire point of a panel. (The example does this.)
- **One quick second opinion** → pick **a single** backend (the cheapest that
  fits). Spinning up three for a small question is waste.
- **Hard read-only guarantee on risky/untrusted code** → prefer **codex**: its
  `-s read-only` is an OS-enforced sandbox (physically can't write or reach the
  network). cursor `--mode ask` / opencode `--agent plan` are reliable but not
  OS-level.
- **You need a specific model/provider** (trusted for this domain, or to match a
  teammate's stack) → **opencode** — it's model-agnostic; pin any `provider/model`.
- **Fast, repo-aware edit or review in a familiar codebase** → **cursor**
  (Composer is tuned for this; remember it has no effort knob).
- **Deep reasoning / heavy bug hunt** → **codex `gpt-5.5` @ xhigh** or **opencode
  `deepseek-v4-pro` @ max** (both high-effort reasoners) — or both, and compare.
- **Cost-sensitive** → fewer agents + lighter settings (`codexCmd(p, {
  model:'gpt-5.3-codex-spark', effort:'low' })`, opencode `--variant minimal`).
- **A model only reachable via your gateway/router, or a cheap extra opinion over
  context you already have** → **`llmCmd`** (the `llm-endpoint` backend). It's a
  raw call, not an agent — feed it the context (use `opts.pipe`), and don't pick it
  for steps that need repo exploration or edits.

Rule of thumb: **more backends = more coverage but more cost/latency.** Scale the
roster to how much the answer matters. To change it, just add/remove the
`roster.push(...)` lines (or the `agent()` calls) for the backends you want — no
config, no launch flags; it's a code decision you make when building the workflow.

## Gotchas

- **The adapter needs Bash** → use `agentType: 'general-purpose'`. That guarantees
  the Bash *tool* is present, but the command still has to clear the permission
  layer. Workflows generally run with vetted commands auto-approved, so the CLIs
  run without extra setup — but if you've tightened Bash permissions (deny rules,
  or a non-auto mode without an allow rule for `codex`/`cursor-agent`/`opencode`
  and the `git` commands they trigger), the headless step will stall on a prompt
  it can't answer. Add allow rules or run the workflow with auto-approval.
- **If Claude Code's Bash sandbox is enabled, the CLI needs network.** The Bash
  sandbox is opt-in (`sandbox.enabled: true`) and **off by default**, so this is
  usually a non-issue. But if it's on, sandboxed Bash gates outbound network: run
  the workflow in auto/bypass mode (auto-approves sandbox network prompts) or add
  the provider hosts to `sandbox.network.allowedDomains`, else the CLI fails with
  DNS/connection errors. (This is the Claude-side Bash sandbox around the whole
  CLI call — distinct from each CLI's own sandbox like codex `-s read-only`.)
- **Verify the CLI exists first** (preflight with `command -v`), or the wrapper
  just returns an error. The example does this and filters the roster.
- **codex hangs without `< /dev/null`** on the arg form; **cursor needs `-p
  --trust` and ignores stdin**; **opencode needs `-m provider/model`.** Get these
  wrong and the step silently fails or stalls.
- **Read-only by default.** Use `-s read-only` / `--mode ask` / `--agent plan`
  for anything that must not change files; escalate deliberately and disclose.
- **Isolate concurrent writers** (`isolation: 'worktree'`) — otherwise parallel
  write-mode agents corrupt each other's edits. But the worktree branches from
  `origin/<default>` by default (`worktree.baseRef: 'fresh'`), so local/unpushed
  work is absent — set `worktree.baseRef: 'head'` if agents must build on current
  state, and never use worktree isolation for a review of the *current* diff (it
  wouldn't see your uncommitted changes).
- **Don't leak secrets** into prompts sent to a third-party model.
- **It's a different model** — disagreement with Claude is the *point* for a
  second opinion; surface both views, don't assume either is right.
