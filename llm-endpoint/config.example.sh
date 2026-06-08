# llm-endpoint config — EXAMPLE / TEMPLATE (safe to commit).
# Copy to the real, LOCAL location and fill in your values — never commit the real one:
#   mkdir -p ~/.config/llm-endpoint
#   cp config.example.sh ~/.config/llm-endpoint/env
#   chmod 600 ~/.config/llm-endpoint/env
#   $EDITOR ~/.config/llm-endpoint/env
# (Env vars of the same name override the file, so you can also export them instead.)

# Base URL of your OpenAI-/Anthropic-compatible endpoint, INCLUDING the /v1 suffix.
export LLM_ENDPOINT_BASE_URL="https://your-endpoint.example.com/v1"

# API key / bearer token for that endpoint.
export LLM_ENDPOINT_API_KEY="sk-REPLACE_ME"

# Default model id. Run `scripts/llm-call.sh --models` to list what's available.
export LLM_ENDPOINT_MODEL="provider/model"

# Default request shape:
#   chat     -> POST /v1/chat/completions   (OpenAI-style)
#   messages -> POST /v1/messages           (Anthropic-style)
# Override per call with --kind. Some routers serve a given model on only one of
# the two; pick whichever returns a result (a 502 on one often works on the other).
export LLM_ENDPOINT_KIND="chat"
