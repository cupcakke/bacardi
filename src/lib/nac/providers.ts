import { z } from "zod";
import { redact } from "./config";
import { emptyUsage, type Message, type SessionConfig, type ToolCall, type Usage } from "./models";

export type ToolDefinition = { name: string; description: string; input_schema: Record<string, unknown> };
export type ProviderResponse = { text: string; tool_calls: ToolCall[]; usage: Usage; stop_reason: string; raw: unknown };
export type StreamDelta = { type: "text" | "tool" | "usage" | "stop"; text?: string; index?: number; id?: string; name?: string; arguments?: string; usage?: Usage; stop_reason?: string };
const object = z.record(z.string(), z.unknown());
const openAIResponse = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional() }), finish_reason: z.string().nullable() })), usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number(), total_tokens: z.number() }).optional() });
const anthropicResponse = z.object({ content: z.array(z.union([z.object({ type: z.literal("text"), text: z.string() }), z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: object }), z.object({ type: z.string() }).passthrough()])), usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }), stop_reason: z.string().nullable() });

export class ProviderError extends Error {
  constructor(message: string, public readonly status = 0, public readonly recoverable = false) { super(redact(message)); this.name = "ProviderError"; }
}
export async function retryRequest(request: () => Promise<Response>, signal: AbortSignal, attempts = 5, elapsedLimit = 120000): Promise<Response> {
  const started = Date.now();
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal.throwIfAborted();
    let delay = Math.random() * Math.min(20000, 1000 * 2 ** attempt);
    try {
      const response = await request();
      if (response.ok) return response;
      const retryable = [408, 409, 429].includes(response.status) || response.status >= 500;
      const text = (await response.text()).slice(0, 2000);
      if (!retryable || attempt === attempts - 1) throw new ProviderError(`Model API ${response.status}: ${text}`, response.status, retryable);
      const header = response.headers.get("retry-after");
      if (header) { const seconds = Number(header); delay = Math.max(delay, Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(header) - Date.now())); }
    } catch (error) {
      if (error instanceof ProviderError || signal.aborted) throw error;
      if (attempt === attempts - 1) throw new ProviderError(error instanceof Error ? error.message : "Model transport failed", 0, true);
    }
    if (Date.now() - started + delay >= elapsedLimit) throw new ProviderError("Model request retry budget exhausted", 0, true);
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  throw new ProviderError("Model request exhausted retries", 0, true);
}
function serializeOpenAI(messages: Message[]): Record<string, unknown>[] {
  return messages.map((message) => ({ role: message.role, content: message.content || null, ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}), ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) }));
}
function serializeAnthropic(messages: Message[]): { system: string; messages: Record<string, unknown>[] } {
  const result: { role: string; content: Record<string, unknown>[] }[] = [];
  for (const message of messages.filter((item) => item.role !== "system")) {
    const role = message.role === "tool" ? "user" : message.role;
    const blocks: Record<string, unknown>[] = [];
    if (message.role === "tool") blocks.push({ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content });
    else {
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    }
    if (!blocks.length) continue;
    if (result.at(-1)?.role === role) result[result.length - 1].content.push(...blocks);
    else result.push({ role, content: blocks });
  }
  return { system: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"), messages: result };
}
export abstract class LLMProvider {
  abstract chat(messages: Message[], tools: ToolDefinition[], model: string, signal: AbortSignal): Promise<ProviderResponse>;
  abstract stream(messages: Message[], tools: ToolDefinition[], model: string, signal: AbortSignal): AsyncGenerator<StreamDelta>;
}
export class HTTPProvider extends LLMProvider {
  constructor(private readonly config: SessionConfig) { super(); }
  private async request(messages: Message[], tools: ToolDefinition[], model: string, signal: AbortSignal, stream: boolean): Promise<Response> {
    const isOpenAI = this.config.provider === "openai";
    const key = isOpenAI ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
    if (!key) throw new ProviderError(`Configure ${isOpenAI ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} on the server before starting a run.`, 401);
    const base = isOpenAI ? (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1") : (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1");
    const body = isOpenAI ? { model, messages: serializeOpenAI(messages), temperature: this.config.temperature, max_completion_tokens: this.config.max_tokens, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), ...(tools.length ? { tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {}) } : { model, ...serializeAnthropic(messages), temperature: this.config.temperature, max_tokens: this.config.max_tokens, stream, ...(tools.length ? { tools } : {}) };
    const headers: Record<string, string> = { "content-type": "application/json", ...(isOpenAI ? { authorization: `Bearer ${key}` } : { "x-api-key": key, "anthropic-version": "2023-06-01" }) };
    return retryRequest(() => fetch(`${base.replace(/\/$/, "")}/${isOpenAI ? "chat/completions" : "messages"}`, { method: "POST", headers, body: JSON.stringify(body), signal }), signal);
  }
  async chat(messages: Message[], tools: ToolDefinition[], model: string, signal: AbortSignal): Promise<ProviderResponse> {
    const raw: unknown = await (await this.request(messages, tools, model, signal, false)).json();
    if (this.config.provider === "openai") {
      const parsed = openAIResponse.parse(raw);
      const choice = parsed.choices[0];
      if (!choice) throw new ProviderError("Model returned no completion");
      return { text: choice.message.content ?? "", tool_calls: (choice.message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: object.parse(JSON.parse(call.function.arguments)) })), usage: parsed.usage ? { input: parsed.usage.prompt_tokens, output: parsed.usage.completion_tokens, total: parsed.usage.total_tokens } : emptyUsage(), stop_reason: choice.finish_reason ?? "unknown", raw };
    }
    const parsed = anthropicResponse.parse(raw);
    const calls: ToolCall[] = [];
    const texts: string[] = [];
    for (const block of parsed.content) {
      if (block.type === "text" && "text" in block && typeof block.text === "string") texts.push(block.text);
      if (block.type === "tool_use" && "id" in block && typeof block.id === "string" && "name" in block && typeof block.name === "string" && "input" in block) calls.push({ id: block.id, name: block.name, arguments: object.parse(block.input) });
    }
    return { text: texts.join("\n"), tool_calls: calls, usage: { input: parsed.usage.input_tokens, output: parsed.usage.output_tokens, total: parsed.usage.input_tokens + parsed.usage.output_tokens }, stop_reason: parsed.stop_reason ?? "unknown", raw };
  }
  async *stream(messages: Message[], tools: ToolDefinition[], model: string, signal: AbortSignal): AsyncGenerator<StreamDelta> {
    const response = await this.request(messages, tools, model, signal, true);
    if (!response.body) throw new ProviderError("Streaming response has no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") return;
          const data = JSON.parse(payload) as Record<string, unknown>;
          if (this.config.provider === "openai") {
            const choices = (data.choices ?? []) as { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
            for (const choice of choices) {
              if (choice.delta?.content) yield { type: "text", text: choice.delta.content };
              for (const call of choice.delta?.tool_calls ?? []) yield { type: "tool", index: call.index, id: call.id, name: call.function?.name, arguments: call.function?.arguments };
              if (choice.finish_reason) yield { type: "stop", stop_reason: choice.finish_reason };
            }
            if (data.usage) { const usage = data.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number }; yield { type: "usage", usage: { input: usage.prompt_tokens, output: usage.completion_tokens, total: usage.total_tokens } }; }
          } else {
            if (data.type === "error") throw new ProviderError(JSON.stringify(data.error));
            if (data.type === "message_start") inputTokens = ((data.message as { usage?: { input_tokens: number } }).usage?.input_tokens ?? 0);
            if (data.type === "content_block_start") { const block = data.content_block as { type: string; id?: string; name?: string }; if (block.type === "tool_use") yield { type: "tool", index: Number(data.index), id: block.id, name: block.name }; }
            if (data.type === "content_block_delta") { const delta = data.delta as { text?: string; partial_json?: string }; if (delta.text) yield { type: "text", text: delta.text }; if (delta.partial_json) yield { type: "tool", index: Number(data.index), arguments: delta.partial_json }; }
            if (data.type === "message_delta") { const output = (data.usage as { output_tokens?: number })?.output_tokens ?? 0; yield { type: "usage", usage: { input: inputTokens, output, total: inputTokens + output } }; const reason = (data.delta as { stop_reason?: string }).stop_reason; if (reason) yield { type: "stop", stop_reason: reason }; }
          }
        }
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
}
export const tokenCount = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 3);
