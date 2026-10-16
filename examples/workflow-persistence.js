// Compare the public graph persistence choices and their observer contract.
import assert from "node:assert/strict";
import { Vfs } from "js-agent/kernel";
import { createEnvironment } from "js-agent/runtime";

export async function runPersistenceConformance({ log = console.log } = {}) {
  const reports = [];
  for (const persistence of ["snapshot", "journal"]) {
    const storage = new Vfs();
    await storage.mount("mem", "/");
    const environment = createEnvironment({
      resources: storage,
      storage,
      model: {
        path: "/models/offline",
        adapter: { async request() { return { content: [{ type: "text", text: "ok" }] }; } },
      },
      permissions: {
        observer: [{ path: "/runs/**", operations: ["stat", "list", "read"] }],
      },
    });
    const graph = environment.createWorkflowGraph({ root: "/workflows", persistence });
    const root = await environment.prepareWorkflow({
      agent: { model: "/models/offline" },
      input: `persistence: ${persistence}`,
    });
    const result = await graph.run({ id: `${persistence}-graph`, root });
    const head = JSON.parse(await storage.read(`/workflows/${persistence}-graph/graph.json`));
    const observed = await environment.observer.snapshot(result.root.id);
    assert.equal(result.status, "completed");
    assert.equal(head.version, persistence === "journal" ? 2 : 1);
    assert.equal(observed.status, "completed");
    assert.equal(observed.storage, "volatile");
    assert.equal(observed.redacted, true);
    assert.equal("response" in observed, false);
    reports.push({ persistence, graphFormat: head.version, observer: {
      status: observed.status,
      storage: observed.storage,
      volatile: observed.volatile,
      redacted: observed.redacted,
    } });
  }
  log(JSON.stringify(reports, null, 2));
  return reports;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  await runPersistenceConformance();
}
