// Example ultracode workflow: a MULTI-MODEL code-review panel.
//
// Reviews the current uncommitted git diff with codex, cursor, opencode, and an
// optional raw LLM endpoint (the llm-endpoint skill) in parallel — each a
// genuinely different model giving an independent read-only review — then a
// Claude agent reconciles them into one deduplicated report. Agreement across
// reviewers => higher confidence.
//
// Run it with the Workflow tool:  Workflow({ scriptPath: "<this file>" })
// or paste the whole thing as the `script` argument.

export const meta = {
  name: 'external-review-panel',
  description: 'Review the current git diff with codex + cursor + opencode + an optional LLM endpoint in parallel, then reconcile with Claude',
  phases: [
    { title: 'Preflight', detail: 'detect which review backends are available' },
    { title: 'Panel',     detail: 'each backend reviews the diff read-only' },
    { title: 'Reconcile', detail: 'Claude merges findings into one report' },
  ],
}

// ── delegation helpers (see templates/delegate.js for the full set) ─────────
function sh(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function delegate(cmd) {
  return [
    "You are a thin adapter around another autonomous coding agent. Do EXACTLY",
    "this and nothing else: run this ONE shell command with the Bash tool (use a",
    "long timeout, ~600000 ms — it may take minutes; do not interrupt):",
    "", "```bash", cmd, "```", "",
    "The CLI prints a progress log then the agent's FINAL message. If you were",
    "asked for structured output, fill the fields from that final message;",
    "otherwise return ONLY that final message verbatim. On non-zero exit, return",
    "its stderr and exit code.",
  ].join("\n");
}
function codexCmd(p, o = {})    { return `codex exec ${sh(p)} -s ${o.mode || "read-only"} -m ${o.model || "gpt-5.5"} -c model_reasoning_effort=${o.effort || "xhigh"} < /dev/null`; }
function cursorCmd(p, o = {})   { const m = o.mode === undefined ? "ask" : o.mode; let c = `cursor-agent -p --trust`; if (m) c += ` --mode ${m}`; c += ` --model ${o.model || "composer-2.5"}`; return c + ` ${sh(p)}`; } // cursor has no effort flag; mode:null/'' → write
function opencodeCmd(p, o = {}) { return `opencode run ${sh(p)} --agent ${o.agent || "plan"} -m ${o.model || "opencode-go/deepseek-v4-pro"} --variant ${o.variant || "max"}`; }
// llm-endpoint is a raw model call (not an agent), so we gather the diff and pipe it in. Model/kind come from local config.
function llmReviewCmd(instr) { return `{ printf '%s\\n\\n' ${sh(instr)}; git diff; git diff --staged; } | "$HOME/.claude/skills/llm-endpoint/scripts/llm-call.sh"`; }

// Verified-live caveats for this panel:
//  - cursor `--mode ask` may block shell/git in some envs; it then reviews the
//    working tree directly (still works). The llm backend can't run git at all,
//    so llmReviewCmd pipes the diff in for it.
//  - the llm reviewer's line numbers are diff-relative (it sees the diff text,
//    not the file), so they can be offset from real file line numbers.
const REVIEW =
  "Review the uncommitted changes in this repo for correctness bugs and risky " +
  "edge cases. Run `git diff` yourself (and `git diff --staged`); if your shell " +
  "is blocked, review the modified working-tree files directly. For each finding " +
  "give file:line, quote the offending line, and explain the bug in one or two " +
  "sentences. Be concise; skip style nits.";

// ── Phase 1: preflight — only include CLIs that are actually installed ───────
phase('Preflight')
const AVAIL = { type: 'object', additionalProperties: false,
  properties: { codex: { type: 'boolean' }, cursor: { type: 'boolean' }, opencode: { type: 'boolean' }, llm: { type: 'boolean' } },
  required: ['codex', 'cursor', 'opencode', 'llm'] }
const avail = await agent(
  "Check which review backends are available by running, separately: " +
  "`command -v codex`, `command -v cursor-agent`, `command -v opencode`, and for the raw LLM endpoint " +
  "`test -x \"$HOME/.claude/skills/llm-endpoint/scripts/llm-call.sh\" && test -f \"$HOME/.config/llm-endpoint/env\" && echo yes`. " +
  "Report codex/cursor/opencode true if the command resolves to a path; report llm true only if that test prints 'yes'.",
  { label: 'preflight', phase: 'Preflight', schema: AVAIL, agentType: 'general-purpose' }
) || { codex: false, cursor: false, opencode: false, llm: false }; // fail CLOSED: if preflight fails, assume nothing is available

const roster = [];
// The roster is a per-task DECISION (see SKILL.md "Choosing the roster"): add or
// remove backends to fit the job. Here we use all installed for a diverse review
// panel — three different models: gpt-5.5 / composer-2.5 / deepseek-v4-pro.
if (avail.codex)    roster.push({ name: 'codex',    cmd: codexCmd(REVIEW) });    // gpt-5.5 @ xhigh
if (avail.cursor)   roster.push({ name: 'cursor',   cmd: cursorCmd(REVIEW) });   // composer-2.5
if (avail.opencode) roster.push({ name: 'opencode',     cmd: opencodeCmd(REVIEW) });  // deepseek-v4-pro @ max
if (avail.llm)      roster.push({ name: 'llm-endpoint', cmd: llmReviewCmd(REVIEW) }); // configured model (e.g. via /messages)
log(`Review panel: ${roster.map(r => r.name).join(', ') || '(no backends available)'}`);

// ── Phase 2: panel — run all reviewers concurrently ─────────────────────────
// parallel() is the right call here (a true barrier): Reconcile needs ALL the
// reviews together to dedupe across them.
phase('Panel')
const reviews = (await parallel(roster.map(r => () =>
  agent(delegate(r.cmd), { label: `review:${r.name}`, phase: 'Panel', agentType: 'general-purpose' })
    .then(text => text && { reviewer: r.name, text })
))).filter(Boolean);

if (!reviews.length) return "No review backends were available — install codex, cursor-agent, or opencode, or configure the llm-endpoint skill.";

// ── Phase 3: reconcile — Claude merges the independent reviews ───────────────
phase('Reconcile')
const report = await agent([
  "You are reconciling code-review findings from several independent AI reviewers",
  "(different models). Merge them into ONE deduplicated report grouped by",
  "file:line. For each issue, note which reviewers flagged it — agreement means",
  "higher confidence. Drop anything clearly spurious or out of scope. End with a",
  "short 'high-confidence issues' summary list.",
  "",
  ...reviews.map(r => `=== Reviewer: ${r.reviewer} ===\n${r.text}`),
].join("\n"), { label: 'reconcile', phase: 'Reconcile' });

return report;
