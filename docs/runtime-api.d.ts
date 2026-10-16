/**
 * Public runtime contract for `js-agent/runtime`.
 *
 * These declarations describe the JavaScript API shipped by this repository. Resource
 * adapters and model/tool handlers are trusted host code; a View or service authority is
 * a capability facade, not a JavaScript sandbox.
 */

export interface ResourceEntry {
  name: string;
  type?: "file" | "dir" | string;
  [key: string]: unknown;
}

export interface ResourceAdapter {
  stat(path: string, options?: unknown): Promise<Record<string, unknown>>;
  list(path: string, options?: unknown): Promise<ResourceEntry[]>;
  read(path: string, options?: unknown): Promise<string>;
  write(path: string, data: unknown, options?: unknown): Promise<unknown>;
  mkdir?(path: string, options?: unknown): Promise<unknown>;
  mkdirp?(path: string, options?: unknown): Promise<unknown>;
  remove?(path: string, options?: unknown): Promise<unknown>;
  rename?(from: string, to: string, options?: unknown): Promise<unknown>;
  exists?(path: string, options?: unknown): Promise<boolean>;
  watch?(path: string, options?: unknown): AsyncIterable<unknown>;
  capabilities?(path: string): Record<string, boolean>;
}

export interface Grant {
  path: string;
  operations: Array<"stat" | "list" | "read" | "write" | "mkdir" | "remove" | "rename" | "watch">;
}

export interface ResourceView extends ResourceAdapter {
  readonly root?: string;
  derive(options?: { grants?: Grant[] }): ResourceView;
  describe(): { grants: Grant[] };
}

export interface ServiceAuthority {
  call(operation: string, input?: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  derive(options?: { grants?: string[] }): ServiceAuthority;
  describe(): { grants: string[] };
}

export interface RunStore {
  readonly root: string;
  readonly mode: "volatile" | "durable";
  reserve(id?: string): Promise<{ id: string; path: string; status: "reserved" }>;
  materialize(id: string, value: { request: unknown; plan: unknown }): Promise<Record<string, unknown>>;
  start(id: string): Promise<Record<string, unknown>>;
  finish(id: string, response: unknown, toolCalls?: unknown[]): Promise<Record<string, unknown>>;
  fail(id: string, status: "failed" | "unknown" | "cancelled", cause?: unknown): Promise<Record<string, unknown>>;
  recover(id: string, options?: { takeover?: boolean }): Promise<Record<string, unknown>>;
  readStatus(id: string): Promise<Record<string, unknown>>;
  lastError(id: string): Error | null;
  isReserved(id: string): boolean;
}

export interface RunEvent {
  seq: number;
  kind: "started" | "completed" | "failed" | "unknown" | "cancelled" | "other";
  at: string | null;
}

export interface RunSnapshot {
  id: string;
  status: "reserved" | "started" | "completed" | "completed_with_tool_calls" | "failed" | "unknown" | "cancelled" | null;
  storage?: "volatile" | "durable";
  terminal: boolean;
  sequence: number;
  events: RunEvent[];
  files: { status: "present" | "missing" | "unavailable"; events: "present" | "missing" | "unavailable" };
  partial: boolean;
  issue?: string;
  volatile: true;
  redacted: true;
}

export interface RunObserver {
  readonly root: string;
  readonly interval: number;
  snapshot(id: string): Promise<RunSnapshot>;
  list(): Promise<RunSnapshot[]>;
  watch(id: string, options?: { after?: number; includeInitial?: boolean; untilTerminal?: boolean; signal?: AbortSignal }): AsyncIterable<RunSnapshot>;
}

export interface AgentSpec {
  model?: string;
  system?: Array<string | { $ref: string; mode?: "live" | "pinned"; revision?: string; selector?: unknown }>;
  context?: Array<string | { $ref: string; mode?: "live" | "pinned"; revision?: string; selector?: unknown }>;
  tools?: string[];
}

export interface ModelAdapter {
  path?: string;
  request(request: Record<string, unknown>, options?: { signal?: AbortSignal; resources?: ResourceView; services?: ServiceAuthority }): Promise<Record<string, unknown>>;
}

export interface ToolAdapter {
  path: string;
  invoke(input: { input: unknown; signal?: AbortSignal; resources?: ResourceView; services?: ServiceAuthority; [key: string]: unknown }): Promise<unknown> | unknown;
  resourceGrants?: Grant[];
  serviceGrants?: string[];
}

export interface Environment {
  readonly store: RunStore;
  run(options?: { agent?: AgentSpec | string; input?: string; id?: string; continuationId?: string; signal?: AbortSignal; [key: string]: unknown }): Promise<Record<string, unknown>>;
  prepareWorkflow(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  createWorkflowGraph(options?: Record<string, unknown>): WorkflowGraph;
  recoverWorkflow(graph: WorkflowGraph, graphId: string, options?: { takeover?: boolean }): Promise<Record<string, unknown>>;
  catalog(): Promise<Array<Record<string, unknown>>>;
  discoverTools(path?: string): Promise<Array<Record<string, unknown>>>;
  readonly observe: { read(path: string, options?: unknown): Promise<string>; list(path: string, options?: unknown): Promise<ResourceEntry[]>; stat(path: string, options?: unknown): Promise<Record<string, unknown>>; inspect(idOrPath: string): Promise<Record<string, unknown>>; describe(): Record<string, unknown> };
  readonly observer: RunObserver;
  readonly permissions: Record<string, () => Record<string, unknown>>;
  describe(): Record<string, unknown>;
}

export interface WorkflowGraph {
  readonly root: string;
  startRoot(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  continueBranch(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  inspect(graphId: string): Promise<Record<string, unknown>>;
  recover(graphId: string): Promise<Record<string, unknown>>;
  cancel(graphId: string): Promise<Record<string, unknown>>;
}

export declare function createView(resources: ResourceAdapter, options?: { grants?: Grant[] }): ResourceView;
export declare function resolveReference(resources: ResourceAdapter, reference: unknown, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function resolveArguments(resources: ResourceAdapter, input: unknown, options?: Record<string, unknown>): Promise<unknown>;
export declare function createRunStore(storage: ResourceAdapter, options?: { root?: string; mode?: "volatile" | "durable"; lockTimeoutMs?: number }): RunStore;
export declare function createRunObserver(storage: ResourceAdapter, options?: { root?: string; interval?: number }): RunObserver;
export declare function invokeOnce(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function buildContinuation(options?: Record<string, unknown>): Readonly<{ messages: unknown[] }>;
export declare function bindToolResource(resources: ResourceAdapter, path: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function loadToolDefinition(resources: ResourceAdapter, path: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function toolCatalog(resources: ResourceAdapter, paths: string[], options?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
export declare function continueOnce(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function assembleContinuationRequest(options?: Record<string, unknown>): Readonly<{ messages: unknown[] }>;
export declare class InMemoryConnector {
  constructor(options?: Record<string, unknown>);
  [key: string]: unknown;
}
export declare function createInMemoryConnector(options?: Record<string, unknown>): InMemoryConnector;
export declare function createServiceAuthority(services?: Record<string, (input: unknown, options?: unknown) => unknown>, options?: { grants?: string[] }): ServiceAuthority;
export declare function createGitRevisionConnector(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function executeToolCalls(toolCalls: unknown[], adapters: Map<string, Function> | Record<string, Function>, options?: Record<string, unknown>): Promise<unknown[]>;
export declare function inspectInvocation(storage: ResourceAdapter, pathOrId: string, options?: { root?: string }): Promise<Record<string, unknown>>;
export declare function runWorkflow(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function createEnvironment(options: { resources: ResourceAdapter; storage?: ResourceAdapter; store?: RunStore; root?: string; model: ModelAdapter; tools?: { paths?: string[]; adapters?: ToolAdapter[]; root?: string }; permissions?: { agent?: Grant[]; model?: Grant[]; tools?: Grant[]; observer?: Grant[] }; services?: ServiceAuthority | Record<string, Function>; observerInterval?: number }): Environment;
export declare function createWorkflowGraph(options: { storage: ResourceAdapter; store: RunStore; root?: string }): WorkflowGraph;
export declare function inspectWorkflowGraph(storage: ResourceAdapter, graphId: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function consumeModelStream(events: AsyncIterable<unknown> | Iterable<unknown>, options?: { onEvent?: (event: unknown) => unknown; signal?: AbortSignal }): Promise<Record<string, unknown>>;
