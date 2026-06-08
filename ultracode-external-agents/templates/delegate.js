// ── External-agent delegation helpers ──────────────────────────────────────
// Copy the helpers you need into the BODY of your workflow script (after the
// `export const meta = {...}` block). Workflow scripts are sandboxed JS with no
// imports and no filesystem/shell access, so these must be inlined — you cannot
// `require()` this file.
//
// What they do: each builder returns a *shell command* string for an external
// coding CLI (codex / cursor-agent / opencode). `delegate()` wraps that command
// in a prompt for a thin Claude subagent that runs it via Bash and relays the
// result. The external model does the real work; the Claude subagent is only an
// adapter. This is the ONLY way to put codex/cursor/opencode inside a workflow,
// because `agent()` always spawns a Claude subagent and the script itself can't
// shell out.
//
// Usage:
//   const out = await agent(delegate(codexCmd("review this repo")),
//                           { label: 'codex', phase: 'Review', agentType: 'general-purpose' })
// With a schema, the same wrapper maps the CLI's answer into your fields:
//   const r = await agent(delegate(codexCmd(prompt)), { schema: MY_SCHEMA, agentType: 'general-purpose' })

// Safely single-quote one shell argument (handles quotes, newlines, $, etc.).
function sh(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Wrap a shell command in a prompt for a thin Claude adapter subagent.
// Works with and without a workflow `schema`:
//   - no schema → returns the external agent's final message verbatim
//   - schema    → the adapter maps that final message into the required fields
// NOTE: give the wrapper `agentType: 'general-purpose'` so it is guaranteed to
// have the Bash tool.
function delegate(cmd) {
  return [
    "You are a thin adapter around another autonomous coding agent. Do EXACTLY",
    "the following and nothing else:",
    "",
    "Run this ONE shell command with the Bash tool (no other commands). It may",
    "take several minutes — use a long Bash timeout (~600000 ms); do not interrupt:",
    "",
    "```bash",
    cmd,
    "```",
    "",
    "The CLI prints a live progress/action log and then the agent's FINAL message.",
    "- If you were asked to produce structured output, populate the fields from",
    "  that final message.",
    "- Otherwise return ONLY that final message, verbatim — no summary, no edits,",
    "  no commentary of your own.",
    "If the command exits non-zero, return its stderr and the exit code instead.",
  ].join("\n");
}

// ── CODEX (OpenAI GPT-5.x) ─────────────────────────────────────────────────
// `-s read-only` is an OS-HARD sandbox (cannot write or reach network).
// stdin MUST be closed (`< /dev/null`) on the arg form or codex hangs forever.
// Requires a git repo unless `skipGit: true`.
// DEFAULTS to `gpt-5.5` at `xhigh` reasoning effort (heavy/expensive, deep work).
// Override for cheap runs: { model:'gpt-5.3-codex-spark', effort:'low' }.
//   mode: 'read-only' | 'workspace-write' | 'danger-full-access'
function codexCmd(prompt, opts = {}) {
  const { mode = "read-only", model = "gpt-5.5", effort = "xhigh", cd, addDir, skipGit, json } = opts;
  let c = `codex exec ${sh(prompt)} -s ${mode}`;
  if (model)   c += ` -m ${model}`;
  if (effort)  c += ` -c model_reasoning_effort=${effort}`;
  if (cd)      c += ` -C ${sh(cd)}`;
  if (addDir)  c += ` --add-dir ${sh(addDir)}`;
  if (skipGit) c += ` --skip-git-repo-check`;
  if (json)    c += ` --json`; // raw JSONL events on stdout (let the adapter pick the final answer)
  return c + ` < /dev/null`;   // REQUIRED for non-interactive runs
}

// ── CURSOR (Composer 2.5 / GPT / Claude) ───────────────────────────────────
// `-p` and `--trust` are mandatory headless. `--mode ask` is RELIABLY read-only;
// `--plan` is only SOFT read-only (can still edit) — don't use it as a write guard.
// stdin is IGNORED: put context in the prompt or tell it to run git itself.
// DEFAULTS to model `composer-2.5`. Cursor has NO reasoning-effort flag — there is
// no --effort/--variant; pick a `*-thinking` model (e.g. 'sonnet-4-thinking',
// 'opus-4-8-thinking') if you want more reasoning instead.
//   mode: 'ask' (read-only, DEFAULT) | 'plan' (soft read-only) | null/'' → full
//         write. Cursor's WRITE mode is the ABSENCE of --mode, so to let it edit
//         you must pass a falsy mode (mode:null) — NOT omit the key (omitting
//         keeps the safe 'ask' default).
//   worktree: name → isolate writes in a git worktree (-w)
function cursorCmd(prompt, opts = {}) {
  const { mode = "ask", model = "composer-2.5", worktree, yolo, json } = opts;
  let c = `cursor-agent -p --trust`;
  if (mode)     c += ` --mode ${mode}`;
  if (model)    c += ` --model ${model}`;
  if (worktree) c += ` -w ${sh(worktree)}`;
  if (yolo)     c += ` --yolo`; // auto-approve commands (needed for unattended build/test)
  c += ` ${sh(prompt)}`;
  if (json)     c += ` --output-format json`; // adapter can parse `.result`
  return c;
}

// ── OPENCODE (model-agnostic: Claude / GPT / open models) ───────────────────
// DEFAULTS to `opencode-go/deepseek-v4-pro` at `--variant max` (max reasoning
// effort). NOTE: opencode model ids are MACHINE-SPECIFIC — this id comes from the
// `opencode-go` provider; run `opencode models` to confirm it's available (or pin
// another). `--variant` is provider-specific and may be ignored if the model
// doesn't support effort levels.
// `--agent plan` = hard read-only (no write tools); `--agent build` = writes in
// the workspace with no extra flag. `ask`-class perms auto-reject in headless.
//   agent: 'plan' (read-only) | 'build' (write) | 'explore' | 'general'
function opencodeCmd(prompt, opts = {}) {
  const { agent = "plan", model = "opencode-go/deepseek-v4-pro", variant = "max", skipPerms, dir, json } = opts;
  let c = `opencode run ${sh(prompt)} --agent ${agent} -m ${model}`;
  if (variant)   c += ` --variant ${variant}`; // minimal | high | max (reasoning effort)
  if (dir)       c += ` --dir ${sh(dir)}`;
  if (skipPerms) c += ` --dangerously-skip-permissions`; // only to act outside the default allow set
  if (json)      c += ` --format json`; // adapter parses text parts
  return c;
}

// ── Convenience: pick a backend by name ────────────────────────────────────
// const cmd = backend('codex', "review this diff", { effort: 'high' })
function backend(name, prompt, opts = {}) {
  if (name === "codex")    return codexCmd(prompt, opts);
  if (name === "cursor")   return cursorCmd(prompt, opts);
  if (name === "opencode") return opencodeCmd(prompt, opts);
  throw new Error(`unknown backend: ${name}`);
}
