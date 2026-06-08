# Agent Skills for Claude Code

A small bundle of [Claude Code](https://claude.com/claude-code) **skills** for
delegating coding work to external AI coding agents — OpenAI **Codex**,
**Cursor**, and **opencode** — plus an orchestration layer that lets *ultracode
workflows* run those agents instead of (or alongside) regular Claude subagents.

## What's inside

| Skill | What it does |
|---|---|
| **`ultracode-external-agents`** | Author ultracode **Workflow** scripts whose `agent()` steps run on Codex / Cursor / opencode instead of Claude. Explains the bridge, ships copy-paste delegation helpers, a runnable multi-model review-panel example, and per-task "which backend(s)" guidance. |
| **`codex-exec`** | Drive OpenAI's Codex CLI non-interactively (`codex exec`) — second opinions, code review, planning, headless implementation, structured output. |
| **`cursor-agent`** | Drive Cursor's CLI agent headless (`cursor-agent -p`) — reviews, planning, implementation, git-worktree isolation. |
| **`opencode`** | Drive the model-agnostic opencode CLI (`opencode run`) — reviews, planning, implementation across many providers. |

`ultracode-external-agents` builds on the other three and points back to them
(via the Skill tool) for the full per-CLI reference.

## Install

Skills live in `~/.claude/skills/`. Copy the folders you want there:

```bash
git clone https://github.com/payne0420/claude-ultracode-agents.git
cd claude-ultracode-agents
cp -R ultracode-external-agents codex-exec cursor-agent opencode ~/.claude/skills/
```

Start a new Claude Code session and the skills will be available. Invoke them by
intent (e.g. "review this with codex", "get a second opinion from opencode") or
by name.

## Requirements

- **Claude Code** (the agent harness).
- For each backend you want to use, the matching CLI installed **and
  authenticated**: `codex`, `cursor-agent`, and/or `opencode`. Each skill checks
  availability before relying on the tool.
- `ultracode-external-agents` is meant for an **ultracode / Workflow** authoring
  turn (Claude Code's multi-agent Workflow tool must be active).

## Notes

- **Model defaults are configurable and machine-specific.** The helpers default
  to codex `gpt-5.5` @ `xhigh` effort, cursor `composer-2.5`, and opencode
  `opencode-go/deepseek-v4-pro` @ `--variant max`. opencode model ids in
  particular vary per machine — run `opencode models` and repoint as needed.
  Every default is overridable per call.
- These skills delegate work to **external / third-party models**. Don't put
  secrets in prompts you send to them.

## License

[MIT](LICENSE).
