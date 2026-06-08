#!/usr/bin/env bash
# llm-call.sh — call a configured OpenAI-compatible (/v1/chat/completions) or
# Anthropic-compatible (/v1/messages) HTTP endpoint and print the reply text.
#
# This is a RAW MODEL CALL, not an agent: it sends one prompt and returns the
# completion. It does NOT read files or run tools — feed it the context you want
# (e.g. pipe in a diff).
#
# The base URL and API key are read from the environment or a local config file —
# they are NEVER hardcoded here, so this script is safe to commit/publish.
# Config resolution (first that sets the vars wins):
#   1. env vars LLM_ENDPOINT_BASE_URL / LLM_ENDPOINT_API_KEY (/ LLM_ENDPOINT_MODEL)
#   2. file $LLM_ENDPOINT_ENV_FILE   (if set)
#   3. file ~/.config/llm-endpoint/env
# See config.example.sh for the format. Requires: curl, jq.
#
# Usage:
#   printf '%s' "your prompt" | llm-call.sh [--model M] [--kind chat|messages]
#   llm-call.sh [--model M] "your prompt"        # prompt as arg instead of stdin
#   { echo "review this:"; git diff; } | llm-call.sh --model M   # pipe context in
#   llm-call.sh --models                          # list available models
# Options: --system "...", --max-tokens N, --temperature T, --raw (full JSON)

set -euo pipefail

# ---- load config (only if env not already set) ----
if [ -z "${LLM_ENDPOINT_BASE_URL:-}" ] || [ -z "${LLM_ENDPOINT_API_KEY:-}" ]; then
  cfg="${LLM_ENDPOINT_ENV_FILE:-$HOME/.config/llm-endpoint/env}"
  # shellcheck disable=SC1090
  [ -f "$cfg" ] && . "$cfg"
fi
BASE="${LLM_ENDPOINT_BASE_URL:-}"
KEY="${LLM_ENDPOINT_API_KEY:-}"
BASE="${BASE%/}"   # strip trailing slash
if [ -z "$BASE" ] || [ -z "$KEY" ]; then
  echo "llm-call.sh: missing config — set LLM_ENDPOINT_BASE_URL and LLM_ENDPOINT_API_KEY" \
       "(env vars or ~/.config/llm-endpoint/env). See config.example.sh." >&2
  exit 2
fi

# ---- parse args (KIND defaults to $LLM_ENDPOINT_KIND, else 'chat') ----
KIND="${LLM_ENDPOINT_KIND:-chat}"; MODEL=""; SYSTEM=""; MAXTOK=""; TEMP=""; RAW=0; DO_MODELS=0; PROMPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --kind)        KIND="$2"; shift 2;;
    --model|-m)    MODEL="$2"; shift 2;;
    --system)      SYSTEM="$2"; shift 2;;
    --max-tokens)  MAXTOK="$2"; shift 2;;
    --temperature) TEMP="$2"; shift 2;;
    --raw)         RAW=1; shift;;
    --models)      DO_MODELS=1; shift;;
    -h|--help)     sed -n '2,30p' "$0"; exit 0;;
    *)             PROMPT="$1"; shift;;
  esac
done

# ---- list models ----
if [ "$DO_MODELS" -eq 1 ]; then
  curl -fsS "$BASE/models" -H "Authorization: Bearer $KEY"
  echo; exit 0
fi

# ---- prompt: arg or stdin ----
if [ -z "$PROMPT" ] && [ ! -t 0 ]; then PROMPT="$(cat)"; fi
[ -n "$PROMPT" ] || { echo "llm-call.sh: no prompt (pass an arg or pipe via stdin)" >&2; exit 2; }
MODEL="${MODEL:-${LLM_ENDPOINT_MODEL:-}}"
[ -n "$MODEL" ] || { echo "llm-call.sh: no model — pass --model or set LLM_ENDPOINT_MODEL" >&2; exit 2; }

if [ "$KIND" = "messages" ]; then
  # ---- Anthropic-compatible: POST /messages ----
  body="$(jq -n --arg m "$MODEL" --arg p "$PROMPT" --arg s "$SYSTEM" \
    --argjson mt "${MAXTOK:-1024}" \
    '{model:$m, max_tokens:$mt, messages:[{role:"user",content:$p}]}
     + (if $s == "" then {} else {system:$s} end)')"
  [ -n "$TEMP" ] && body="$(printf '%s' "$body" | jq --argjson t "$TEMP" '. + {temperature:$t}')"
  resp="$(curl -fsS "$BASE/messages" \
    -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" -d "$body")"
  if [ "$RAW" -eq 1 ]; then printf '%s\n' "$resp"
  else printf '%s' "$resp" | jq -r '[.content[]? | select(.type=="text") | .text] | join("")'; fi
else
  # ---- OpenAI-compatible: POST /chat/completions ----
  msgs="$(jq -n --arg p "$PROMPT" --arg s "$SYSTEM" \
    'if $s == "" then [{role:"user",content:$p}]
     else [{role:"system",content:$s},{role:"user",content:$p}] end')"
  body="$(jq -n --arg m "$MODEL" --argjson msgs "$msgs" '{model:$m, messages:$msgs}')"
  [ -n "$MAXTOK" ] && body="$(printf '%s' "$body" | jq --argjson n "$MAXTOK" '. + {max_tokens:$n}')"
  [ -n "$TEMP" ]   && body="$(printf '%s' "$body" | jq --argjson t "$TEMP" '. + {temperature:$t}')"
  resp="$(curl -fsS "$BASE/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d "$body")"
  if [ "$RAW" -eq 1 ]; then printf '%s\n' "$resp"
  else printf '%s' "$resp" | jq -r '.choices[0].message.content // (.choices[0].text) // ""'; fi
fi
