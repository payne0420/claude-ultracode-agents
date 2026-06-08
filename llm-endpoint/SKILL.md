---
name: llm-endpoint
description: >-
  Call a configured OpenAI-compatible (`/v1/chat/completions`) or
  Anthropic-compatible (`/v1/messages`) HTTP endpoint as a lightweight model
  backend — a raw completion call, not an autonomous agent. Use as an alternative
  to the codex/cursor/opencode CLI harnesses when you want to hit an arbitrary
  model behind a gateway/router/proxy (e.g. for a second opinion, a quick review
  of pasted/piped context, or text generation), or to plug such an endpoint into
  an ultracode workflow. The base URL and API key are read from local config and
  are never hardcoded. Works with any `/v1` chat or `/v1/messages` endpoint.

  Triggers: "use my llm endpoint", "call my openai-compatible endpoint", "hit
  /v1/chat/completions", "use the /v1/messages endpoint", "use my model gateway /
  router / proxy", "second opinion from my endpoint", "run this through my API
  endpoint".
---

# llm-endpoint — call a configured chat/messages API

This skill calls an OpenAI- or Anthropic-compatible HTTP endpoint and returns the
reply text. It is a **raw model call, not an agent**: it sends one prompt and gets
one completion. Unlike `codex` / `cursor-agent` / `opencode`, it does **not**
read files, run commands, or explore a repo — you must **feed it the context**
(put it in the prompt, or pipe it in).

Use it when you want a specific model behind a gateway/router/proxy for: a second
opinion, a review of a diff/snippet you provide, classification, or text
generation — without the overhead (or autonomy) of a full coding-agent CLI.

## Setup — secrets stay local, never in git

The base URL and API key live in a **local config file outside any repo** so they
are never committed:

```bash
mkdir -p ~/.config/llm-endpoint
cp ~/.claude/skills/llm-endpoint/config.example.sh ~/.config/llm-endpoint/env
chmod 600 ~/.config/llm-endpoint/env
$EDITOR ~/.config/llm-endpoint/env     # fill in BASE_URL, API_KEY, MODEL, KIND
```

The script reads, in order: existing env vars → `$LLM_ENDPOINT_ENV_FILE` →
`~/.config/llm-endpoint/env`. Vars:

| Var | Meaning |
|-----|---------|
| `LLM_ENDPOINT_BASE_URL` | endpoint base, **including `/v1`** (e.g. `https://host/v1`) |
| `LLM_ENDPOINT_API_KEY`  | bearer / api key |
| `LLM_ENDPOINT_MODEL`    | default model id (`--model` overrides) |
| `LLM_ENDPOINT_KIND`     | default shape: `chat` or `messages` (`--kind` overrides) |

The script itself, `config.example.sh`, and this doc contain **no secrets** — they
are safe to publish. The real `~/.config/llm-endpoint/env` is the only place the
key lives; keep it out of version control.

## Usage

`scripts/llm-call.sh` (needs `curl` + `jq`):

```bash
S=~/.claude/skills/llm-endpoint/scripts/llm-call.sh

# Prompt as arg or via stdin; model/kind default to config
"$S" "Explain optimistic locking in two sentences."
printf 'Summarize this repo in one line.' | "$S"

# Pipe context in — e.g. review the current diff
{ echo "Review this diff for bugs, cite the line:"; git diff; } | "$S"

# Pick model / shape explicitly
"$S" --model provider/model --kind messages "your prompt"
"$S" --kind chat --model some-openai-model "your prompt"

# Options
"$S" --system "You are a terse code reviewer." --max-tokens 800 --temperature 0.2 "..."
"$S" --models          # list available model ids
"$S" --raw "..."       # full JSON response instead of just the text
```

`--kind chat` → `POST {base}/chat/completions` (OpenAI shape, `Authorization:
Bearer`). `--kind messages` → `POST {base}/messages` (Anthropic shape, `x-api-key`
+ `anthropic-version`). The script extracts the assistant text from either.

## When to use this vs a CLI harness

- **Use `llm-endpoint`** when you just need a model's answer over some context you
  already have (paste/pipe it): second opinions, reviewing a provided diff,
  Q&A, generation, classification — especially for a model only reachable via your
  gateway.
- **Use `codex` / `cursor-agent` / `opencode`** (see those skills) when you need an
  **agent** that explores the repo, runs commands, or edits files autonomously.
  This endpoint can't do that — it only sees what you send it.

## In an ultracode workflow

The `ultracode-external-agents` skill ships an `llmCmd()` helper so a workflow can
delegate a step to this endpoint (the Claude adapter runs the script and relays
the answer). Because it's not an agent, gather the context in the command — e.g.
pipe `git diff` in. See that skill's "Raw LLM endpoint backend" section.

## Gotchas

- **Not an agent.** No file/repo access — it only sees the prompt you send. Pipe
  or paste the context.
- **Secrets are local-only.** Never hardcode or commit the URL/key; they belong in
  `~/.config/llm-endpoint/env`.
- **`chat` vs `messages` per model.** A gateway may serve a given model on only
  one shape — if one returns an error, try the other and set `LLM_ENDPOINT_KIND`.
  The chat path sends `"stream": false` because some gateways stream SSE by default
  (which can't be parsed as a single object — and a *streaming* failure can even
  surface as a `502 stream_early_eof` that non-streaming avoids). The script still
  falls back to reassembling SSE if a gateway streams anyway.
- **Reasoning/"thinking" models + `--max-tokens`.** Models that emit a hidden
  thinking block spend the token budget on reasoning first; a *low* `--max-tokens`
  can be consumed entirely by thinking (`stop_reason: length`), leaving the answer
  text empty. Raise `--max-tokens` (default 1024) if a reasoning model returns
  nothing. The script returns only the final answer text, not the thinking.
- **HTTP errors are surfaced.** A non-2xx response prints `HTTP <code>` plus the
  error body to stderr and exits non-zero (instead of silently returning empty).
- **Needs `curl` and `jq`.**
- **Don't leak secrets** into prompts — you're sending them to a third-party model.
