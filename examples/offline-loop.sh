#!/usr/bin/env bash
# the whole agent loop, with no network in the process at all
#
# the scripted dialect answers in canonical form and emits real Anthropic SSE frames through
# the real streaming machine, so request → tool call → result → second round → final answer
# all run for real. the only thing missing is the wire — which is the point.

set -u
ROOT_JS="$(cd "$(dirname "$0")/.." && pwd)/bin/js-agent"
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# the model's two turns: ask for a tool, then answer with what came back
SCRIPT='[
  {"content":[{"type":"tool_use","id":"t1","name":"read","input":{"path":"/host/package.json"}}],"stop_reason":"tool_use"},
  {"content":[{"type":"text","text":"It is the js-agent package.json, at version 0.1.0."}],"stop_reason":"end_turn"}
]'

node "$ROOT_JS" --root "$ROOT" \
     --mount "ai:/dev/providers/ai,vendor=fake,script=$SCRIPT" \
     --tools read,ls,js,shell \
     --agent "read package.json and tell me what it is" --agent-tools read,ls

echo
echo "--- and the record of that run, from the event stream ---"
rm -rf /tmp/js-agent-demo
node "$ROOT_JS" --root "$ROOT" --state /tmp/js-agent-demo \
     --mount "ai:/dev/providers/ai,vendor=fake,script=$SCRIPT" \
     --tools read,ls --agent "again" --agent-tools read,ls
for f in /tmp/js-agent-demo/events/*.jsonl; do
  node -e '
    const fs = require("node:fs");
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      const rest = { ...e }; delete rest.run; delete rest.ts; delete rest.kind;
      console.log(e.kind.padEnd(13), JSON.stringify(rest).slice(0, 100));
    }' "$f"
  break
done
