// e2e.test.js — a real model endpoint.
//
// ── what this covers that the others cannot ──
// everything else in this suite is hermetic, and hermetic means it agrees with whatever the
// author believed about the wire format. this is the one place that belief meets a server.
//
// ── and why it reports itself skipped ──
// without credentials it exits **zero** with a visible skip, so it drops into CI unchanged
// and a missing key is never mistaken for a passing test. a genuine failure exits non-zero.
//
//   ANTHROPIC_AUTH_TOKEN=…  node test/run.js e2e
//   OPENAI_API_KEY=…        node test/run.js e2e

import { test } from "node:test";
import assert from "node:assert/strict";
import { namespace } from "./helpers.js";
import { run, stripAlias } from "../src/core/agent.js";

const anthropicKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || null;
const openaiKey = process.env.OPENAI_API_KEY || null;

/** the mounts a live run needs, in the order a person would type them.
 *
 *  the allowlist is taken from the base URL rather than hardcoded: a gateway in front of the
 *  API is the ordinary case, and a test that allowlists `api.anthropic.com` while pointing
 *  at somewhere else would fail on the allowlist and read like a network problem. */
function liveMounts({ vendor, models, base }) {
  const tokenName = vendor === "anthropic" ? "ANTHROPIC_AUTH_TOKEN" : "OPENAI_API_KEY";
  const host = new URL(base ?? (vendor === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com")).hostname;
  const options = { vendor, "token-file": `/dev/secrets/${tokenName}`, models: models.join(",") };
  if (base) options.url = base;
  return [
    { driver: "secret", at: "/dev/secrets", options: { env: tokenName } },
    { driver: "net", at: "/dev/net", options: { allow: host } },
    { driver: "ai", at: "/dev/providers/ai", options },
  ];
}

// the model comes from the environment, because on a machine with a gateway the served
// names are the gateway's and not the vendor's defaults. the CLI alias suffix is stripped
// by the agent itself — `deepseek-flash[1M]` is what a CLI exports, not what an API serves.
const anthropicModels = [stripAlias(process.env.ANTHROPIC_MODEL || "claude-sonnet-5")];
const openaiModels = [stripAlias(process.env.OPENAI_MODEL || "gpt-4o-mini")];

for (const [vendor, key, models] of [
  ["anthropic", anthropicKey, anthropicModels],
  ["openai", openaiKey, openaiModels],
]) {
  const base = process.env[vendor === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"];
  const env = base ? { base } : {};

  test(`e2e/${vendor}: a real round trip`, { skip: key ? false : `no ${vendor} credentials in the environment` }, async () => {
    const vfs = await namespace({ tools: ["read", "ls"], mounts: liveMounts({ vendor, models, ...env }) });

    // the descriptor first: it is free, it is offline, and it says whether the mount is
    // actually usable before anything is spent
    const descriptor = JSON.parse(await vfs.read(`/dev/providers/ai/type/api/${vendor}/${vendor === "anthropic" ? "messages" : "chat"}/model/${models[0]}`));
    assert.equal(descriptor.auth_present, true, "the credential did not reach the driver");
    assert.equal(descriptor.net_mounted, true);

    const r = await run(vfs, {
      prompt: "Reply with exactly the word: pong",
      tools: ["read", "ls"],
      stream: false,
      onText: null,
      maxTokens: 64,
    });
    assert.equal(r.status, "done");
    assert.match(r.text.toLowerCase(), /pong/);
    assert.ok(r.input_tokens > 0, "a real endpoint reports usage");
  });
}

test("e2e: a tool call round trip against a real endpoint", { skip: anthropicKey ? false : "no anthropic credentials in the environment" }, async () => {
  const vfs = await namespace({
    tools: ["read", "ls"],
    mounts: liveMounts({
      vendor: "anthropic",
      models: anthropicModels,
      base: process.env.ANTHROPIC_BASE_URL,
    }),
  });

  const r = await run(vfs, {
    prompt: "Read /proc/version with the read tool, then tell me the node version in it. Use the tool; do not guess.",
    tools: ["read", "ls"],
    stream: false,
    onText: null,
    maxTokens: 1024,
  });

  assert.equal(r.tool_calls >= 1, true, "the model should have reached for the tool");
  const called = r.canonical.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_use");
  assert.equal(called[0].name, "read");
  assert.ok(r.text.length > 0);
});
