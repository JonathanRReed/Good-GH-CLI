import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

type RpcId = string | number;
const PROTOCOL_VERSION = "2024-11-05";
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENT_CALLS = 4;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validArguments(schema: Record<string, unknown>, value: unknown): value is Record<string, unknown> {
  if (!object(value)) return false;
  const properties = object(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some((key) => typeof key !== "string" || !Object.hasOwn(value, key))) return false;
  for (const [key, field] of Object.entries(value)) {
    if (!Object.hasOwn(properties, key)) return false;
    const rule = properties[key];
    if (!object(rule)) return false;
    if (rule.type === "string" && typeof field !== "string") return false;
    if (rule.type === "integer" && !Number.isSafeInteger(field)) return false;
    if (rule.type === "number" && (typeof field !== "number" || !Number.isFinite(field))) return false;
    if (typeof rule.minimum === "number" && (typeof field !== "number" || field < rule.minimum)) return false;
    if (typeof rule.maximum === "number" && (typeof field !== "number" || field > rule.maximum)) return false;
    if (Array.isArray(rule.enum) && !rule.enum.includes(field)) return false;
  }
  return true;
}

/** Bounded JSONL transport for the deliberately read-only MCP surface. */
export async function serveMcp(
  tools: McpTool[], version: string, input: Readable = process.stdin, output: Writable = process.stdout,
): Promise<void> {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const pending = new Map<RpcId, Promise<void>>();
  let initialized = false;
  let ready = false;
  let writes = Promise.resolve();
  const send = (response: object): Promise<void> => {
    writes = writes.then(async () => {
      const data = JSON.stringify(response) + "\n";
      if (!output.write(data)) await once(output, "drain");
    });
    return writes;
  };
  const error = (id: RpcId | null, code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });
  const result = (id: RpcId, value: unknown) => send({ jsonrpc: "2.0", id, result: value });

  async function dispatch(line: string): Promise<void> {
    let request: unknown;
    try { request = JSON.parse(line); }
    catch { await error(null, -32700, "Parse error"); return; }
    if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      await error(null, -32600, "Invalid request"); return;
    }
    const { id, method, params } = request;
    if (id === undefined) {
      // Notifications never receive a response and never execute request methods.
      if (method === "notifications/initialized" && initialized) ready = true;
      return;
    }
    if (!(typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id)))) {
      await error(null, -32600, "Invalid request id"); return;
    }
    if (pending.has(id)) { await error(id, -32600, "Request id is already in flight"); return; }
    if (params !== undefined && !object(params)) { await error(id, -32602, "Params must be an object"); return; }
    if (method === "ping") { await result(id, {}); return; }
    if (method === "initialize") {
      if (initialized) { await error(id, -32600, "Already initialized"); return; }
      if (!object(params) || typeof params.protocolVersion !== "string" || !object(params.capabilities) ||
          !object(params.clientInfo) || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") {
        await error(id, -32602, "Initialize requires protocolVersion, capabilities and clientInfo"); return;
      }
      initialized = true;
      await result(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "ggh", version } });
      return;
    }
    if (!ready) { await error(id, -32600, "Initialize and send notifications/initialized first"); return; }
    if (method === "tools/list") {
      await result(id, { tools: tools.map(({ name, description, inputSchema }) =>
        ({ name, description, inputSchema: { ...inputSchema, additionalProperties: false } })) });
      return;
    }
    if (method !== "tools/call") { await error(id, -32601, "Method not found"); return; }
    const name = params?.name;
    const tool = typeof name === "string" ? toolMap.get(name) : undefined;
    const args = params?.arguments === undefined ? {} : params.arguments;
    if (!tool || !validArguments(tool.inputSchema, args)) {
      await error(id, -32602, "Unknown tool or invalid tool arguments"); return;
    }
    if (pending.size >= MAX_CONCURRENT_CALLS) { await error(id, -32000, "Too many concurrent tool calls"); return; }
    const task = (async () => {
      try {
        const value = JSON.stringify(await tool.handler(args));
        if (Buffer.byteLength(value ?? "null") > MAX_RESPONSE_BYTES) throw new Error("Tool result exceeds 4 MiB; request less data.");
        await result(id, { content: [{ type: "text", text: value ?? "null" }] });
      } catch (err) {
        await result(id, { isError: true, content: [{ type: "text", text: (err instanceof Error ? err.message : String(err)).slice(0, 2000) }] });
      } finally { pending.delete(id); }
    })();
    pending.set(id, task);
  }

  // A fixed-size buffer bounds memory even for a stream that never sends a newline.
  const frame = Buffer.alloc(MAX_FRAME_BYTES);
  let used = 0;
  let dropping = false;
  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (!dropping) {
        if (used + end - start > frame.length) {
          used = 0; dropping = true;
          await error(null, -32600, "Request exceeds 1 MiB");
        } else { used += chunk.copy(frame, used, start, end); }
      }
      if (newline < 0) break;
      if (!dropping && used) await dispatch(frame.toString("utf8", 0, used));
      used = 0; dropping = false; start = newline + 1;
    }
  }
  if (!dropping && used) await dispatch(frame.toString("utf8", 0, used));
  await Promise.all(pending.values());
  await writes;
}
