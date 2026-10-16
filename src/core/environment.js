import { createView } from "../kernel/view.js";
import { normalize } from "../kernel/paths.js";
import { createRunStore } from "./run-store.js";
import { toolCatalog } from "./tool-resource.js";
import { runWorkflow, inspectInvocation } from "./workflow-harness.js";

const VIEW_NAMES = ["agent", "model", "tools", "observer"];

function fail(message, code = "EINVAL") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail(`${label} must be an object`);
  }
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("//") || value.split("/").includes("..")) {
    throw fail(`${label} must be an absolute path`);
  }
  return normalize(value);
}

function grants(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw fail(`${label} must be an array`);
  return value;
}

function adapterMethod(adapter, method, label) {
  if (typeof adapter === "function") return adapter;
  object(adapter, label);
  if (typeof adapter[method] !== "function") throw fail(`${label}.${method} must be a function`);
  return adapter[method].bind(adapter);
}

function adapterRecord(value, index) {
  object(value, `tools.adapters[${index}]`);
  const path = absolutePath(value.path, `tools.adapters[${index}].path`);
  const invoke = adapterMethod(value.invoke, "invoke", `tools.adapters[${index}]`);
  return { path, invoke };
}

function viewDescription(view) {
  return () => view.describe();
}

function observerPath(root, value) {
  if (typeof value !== "string" || value.length === 0) throw fail("run id or path must be a nonempty string");
  return value.startsWith("/") ? normalize(value) : `${root}/${value}`;
}

/**
 * Build a small resource-backed application boundary.
 *
 * The resource tree is shared, but permissions are four independent views:
 * the agent resolves prompt/context references, the model adapter receives its
 * own service view, tool adapters receive another service view, and observers
 * read run state through a view over storage. Model and tool adapters remain
 * trusted host functions; this API makes that boundary explicit rather than
 * pretending a resource read is a sandbox for adapter code.
 *
 * Tool paths are an explicit catalog. Directory discovery is available only via
 * discoverTools(), which requires list authority and is never used by run().
 */
export function createEnvironment({
  resources,
  storage = resources,
  store,
  root = "/runs",
  model,
  tools = {},
  permissions = {},
} = {}) {
  if (!resources || typeof resources !== "object") throw fail("resources must be a resource adapter");
  if (!storage || typeof storage !== "object") throw fail("storage must be a resource adapter");
  object(model, "model");
  const modelPath = absolutePath(model.path, "model.path");
  const modelRequest = adapterMethod(model.adapter, "request", "model.adapter");
  object(tools, "tools");
  if (tools.paths !== undefined && !Array.isArray(tools.paths)) throw fail("tools.paths must be an array");
  if (tools.adapters !== undefined && !Array.isArray(tools.adapters)) throw fail("tools.adapters must be an array");
  const toolPaths = tools.paths === undefined ? [] : tools.paths.map((path, index) => absolutePath(path, `tools.paths[${index}]`));
  const toolAdapters = (tools.adapters ?? []).map(adapterRecord);
  const toolAdapterByPath = new Map();
  for (const adapter of toolAdapters) {
    if (toolAdapterByPath.has(adapter.path)) throw fail(`duplicate trusted tool adapter: ${adapter.path}`, "EEXIST");
    toolAdapterByPath.set(adapter.path, adapter.invoke);
  }
  const runRoot = absolutePath(root, "root");

  const agentView = createView(resources, { grants: grants(permissions.agent, "permissions.agent") });
  const modelView = createView(resources, { grants: grants(permissions.model, "permissions.model") });
  const toolsView = createView(resources, { grants: grants(permissions.tools, "permissions.tools") });
  const observerView = createView(storage, { grants: grants(permissions.observer, "permissions.observer") });
  const runStore = store ?? createRunStore(storage, { root: runRoot });
  if (!runStore || typeof runStore.reserve !== "function") throw fail("store must be a RunStore");

  async function catalog() {
    return toolCatalog(toolsView, toolPaths);
  }

  async function discoverTools(path = tools.root ?? "/tools") {
    const base = absolutePath(path, "tool discovery path");
    const entries = await toolsView.list(base);
    return toolCatalog(toolsView, entries.map((entry) => `${base}/${entry.name}`));
  }

  function modelForRun() {
    return {
      path: modelPath,
      async request(request, options = {}) {
        return modelRequest(request, { ...options, resources: modelView });
      },
    };
  }

  /**
   * Materialize the same trusted, View-scoped execution options used by run().
   * A workflow coordinator can pass the result to startRoot() and continueBranch()
   * without reconstructing this environment's catalog or adapter boundary.
   */
  async function prepareWorkflow(options = {}) {
    object(options, "workflow options");
    const definitions = await catalog();
    const adapters = new Map();
    for (const definition of definitions) {
      const adapter = toolAdapterByPath.get(definition.path);
      if (!adapter) throw fail(`no trusted adapter supplied for tool path ${definition.path}`, "EACCES");
      adapters.set(definition.name, async ({ input: toolInput, ...adapterOptions }) => adapter({
        ...adapterOptions,
        input: toolInput,
        path: definition.path,
        definition,
        resources: toolsView,
      }));
    }
    return {
      ...options,
      storage,
      resources: agentView,
      model: modelForRun(),
      tools: definitions,
      store: runStore,
      toolAdapters: adapters,
    };
  }

  async function run(options = {}) {
    return runWorkflow(await prepareWorkflow(options));
  }

  const observe = Object.freeze({
    read: (path, options) => observerView.read(path, options),
    list: (path, options) => observerView.list(path, options),
    stat: (path, options) => observerView.stat(path, options),
    inspect: (idOrPath) => inspectInvocation(observerView, observerPath(runRoot, idOrPath), { root: runRoot }),
    describe: viewDescription(observerView),
  });

  const permissionDescriptions = Object.freeze({
    agent: viewDescription(agentView),
    model: viewDescription(modelView),
    tools: viewDescription(toolsView),
    observer: viewDescription(observerView),
  });

  const describe = () => ({
    adapterBoundary: {
      model: { path: modelPath, kind: "trusted-host-adapter" },
      tools: toolPaths.map((path) => ({ path, kind: "trusted-host-adapter" })),
    },
    catalogs: { tools: [...toolPaths] },
    permissions: Object.fromEntries(VIEW_NAMES.map((name) => [name, permissionDescriptions[name]()])),
    runs: { root: runRoot, storage: "run-store" },
  });

  return Object.freeze({
    run,
    prepareWorkflow,
    catalog,
    discoverTools,
    observe,
    permissions: permissionDescriptions,
    describe,
  });
}
