#!/usr/bin/env bash
# mount a model, in the three steps the design requires — and watch each one refuse on its own
#
# a model is not a network request here. it is a device file, and reaching it takes a
# namespace, a credential and a transport, each mounted separately.

set -u
ROOT_JS="$(cd "$(dirname "$0")/.." && pwd)/bin/js-agent"
js_agent() { node "$ROOT_JS" "$@"; }
TOKEN="${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"
BASE="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
HOST=$(node -e "console.log(new URL(process.argv[1]).hostname)" "$BASE")
# strip the CLI alias suffix. `deepseek-flash[1M]` is what a Claude-Code-style CLI exports;
# it is not a model name, and the endpoint answers 404 naming the model it never heard of.
# the agent does this for itself — see stripAlias in src/core/agent.js — but a path typed by
# hand gets exactly what was typed, which is the honest behaviour and the reason it is worth
# doing here by hand too.
MODEL=$(node -e 'console.log((process.argv[1]||"claude-sonnet-5").replace(/\s*\[[^\]]*\]\s*$/,"").trim())' "${ANTHROPIC_MODEL:-claude-sonnet-5}")

green() { printf '\033[32m%s\033[0m\n' "$1"; }
note()  { printf '\033[90m%s\033[0m\n' "$1"; }

note "1. no model mounted — the namespace simply has no /dev/providers"
node "$ROOT_JS" -e 'ls /dev' || true

note ""
note "2. the model mounted, but nothing to reach it with"
js_agent --mount "ai:/dev/providers/ai,vendor=anthropic,models=$MODEL" \
   -e "write /dev/providers/ai/type/api/anthropic/messages/model/$MODEL '{\"max_tokens\":8,\"messages\":[]}'" 2>&1 | head -3

note ""
note "3. add a credential, still no network"
js_agent --mount "secret:/dev/secrets,env=ANTHROPIC_AUTH_TOKEN" \
   --mount "ai:/dev/providers/ai,vendor=anthropic,models=$MODEL,token-file=/dev/secrets/ANTHROPIC_AUTH_TOKEN" \
   -e "write /dev/providers/ai/type/api/anthropic/messages/model/$MODEL '{\"max_tokens\":8,\"messages\":[]}'" 2>&1 | head -3

note ""
if [ -z "$TOKEN" ]; then
  note "no ANTHROPIC_AUTH_TOKEN in the environment, so the live part stops here."
  note "everything above worked without one, which is the point."
  exit 0
fi

note "4. all three mounts — and the same line now answers"
green "descriptor:"
js_agent --mount "secret:/dev/secrets,env=ANTHROPIC_AUTH_TOKEN" \
   --mount "net:/dev/net,allow=$HOST" \
   --mount "ai:/dev/providers/ai,vendor=anthropic,models=$MODEL,token-file=/dev/secrets/ANTHROPIC_AUTH_TOKEN,url=$BASE" \
   -e "cat /dev/providers/ai/type/api/anthropic/messages/model/$MODEL" 2>&1 | head -12

note ""
green "and a reply, by writing a request to the file:"
js_agent --mount "secret:/dev/secrets,env=ANTHROPIC_AUTH_TOKEN" \
   --mount "net:/dev/net,allow=$HOST" \
   --mount "ai:/dev/providers/ai,vendor=anthropic,models=$MODEL,token-file=/dev/secrets/ANTHROPIC_AUTH_TOKEN,url=$BASE" \
   -e "write /dev/providers/ai/type/api/anthropic/messages/model/$MODEL '{\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"say pong and nothing else\"}]}'" 2>&1 | head -20
