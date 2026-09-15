import { z } from "zod";

export const usageSchema = z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict();
export type Usage = z.infer<typeof usageSchema>;
export const emptyUsage = (): Usage => ({ input: 0, output: 0, total: 0 });
export const errorSchema = z.object({ type: z.string(), message: z.string(), recoverable: z.boolean(), environment_may_have_advanced: z.boolean() }).strict();
export type EpisodeError = z.infer<typeof errorSchema>;
export const episodeSubmissionSchema = z.object({
  summary: z.string().min(1).max(4000),
  useful_files: z.array(z.object({ path: z.string().min(1).max(1024), role: z.string().max(1000), line_range: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).max(80),
  results: z.array(z.object({ key: z.string().max(200), value: z.string().max(4000) }).strict()).max(80),
  open_questions: z.array(z.string().max(1000)).max(30),
  next_steps: z.array(z.string().max(1000)).max(30),
  status: z.enum(["complete", "partial", "failed"]),
}).strict();
export const episodeSchema = episodeSubmissionSchema.extend({ episode_id: z.string(), thread_id: z.string(), sequence: z.number().int().positive(), created_at: z.string().datetime(), requested_action: z.string(), token_usage: usageSchema, duration_ms: z.number().nonnegative(), source_episode_refs: z.array(z.string()), error: errorSchema.optional() }).strict();
export type Episode = z.infer<typeof episodeSchema>;
export const policySchema = z.object({ allow: z.array(z.string()).max(30).default([]), deny: z.array(z.string()).max(30).default([]), allow_mutating: z.boolean().default(true), allow_shell: z.boolean().default(false), allow_network: z.boolean().default(false), working_dir: z.string().max(1024).default("."), max_tool_calls: z.number().int().min(1).max(200).default(40) }).strict();
export type ToolPolicy = z.infer<typeof policySchema>;
export const threadSchema = z.object({ thread_id: z.string(), name: z.string().min(1).max(80), system_prompt: z.string().min(1).max(16000), created_at: z.string().datetime(), updated_at: z.string().datetime(), status: z.enum(["ready", "running", "complete", "failed"]), tags: z.array(z.string().max(40)).max(12), tool_policy: policySchema, episodes: z.array(episodeSchema) }).strict();
export type Thread = z.infer<typeof threadSchema>;
export const callSchema = z.object({ call_id: z.string().min(1).max(80), thread_name: z.string().min(1).max(80), create_if_missing: z.boolean().default(true), thread_system_prompt: z.string().max(16000).optional(), requested_action: z.string().min(1).max(24000), source_threads: z.array(z.string()).max(40).default([]), source_episodes: z.array(z.string()).max(100).default([]), depends_on: z.array(z.string()).max(40).default([]), tool_policy: policySchema.optional(), model: z.string().max(100).optional(), max_turns: z.number().int().min(1).max(100).optional(), timeout_sec: z.number().int().min(10).max(1800).optional() }).strict();
export type ThreadCall = z.infer<typeof callSchema>;
export const batchSchema = z.object({ rationale: z.string().max(4000).optional(), calls: z.array(callSchema).min(1).max(40) }).strict();
export type BatchPlan = z.infer<typeof batchSchema>;
export type CallResult = { call_id: string; thread_name: string; status: "complete" | "partial" | "failed" | "skipped"; episode?: Episode; error?: EpisodeError; failed_dependencies?: string[]; duration_ms: number; token_usage: Usage };
export type BatchReport = { batch_id: string; rationale: string; started_at: string; finished_at?: string; status: "running" | "complete"; calls: CallResult[]; counts: Record<CallResult["status"], number>; token_usage: Usage; duration_ms: number };
export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type Message = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: ToolCall[]; tool_call_id?: string };
export type RunRecord = { run_id: string; prompt: string; started_at: string; finished_at?: string; status: "running" | "complete" | "failed" | "cancelled"; phase: "planning" | "dispatching" | "finished"; model: string; batches: BatchReport[]; token_usage: Usage; final_answer?: string; error?: EpisodeError; cancel_requested: boolean; heartbeat_at: string };
export type SteeringItem = { id: string; text: string; thread_name?: string; queued_at: string; consumed_at?: string; consumption_point?: string };
export type RuntimeEvent = { id: string; type: string; message: string; created_at: string; session_id: string; run_id?: string; batch_id?: string; call_id?: string; thread_id?: string; episode_id?: string; details?: Record<string, unknown> };
export const sessionConfigSchema = z.object({ provider: z.enum(["openai", "anthropic"]).default("openai"), worker_model: z.string().min(1).max(100).default("gpt-4.1-mini"), orchestrator_model: z.string().min(1).max(100).default("gpt-4.1-mini"), max_parallel: z.number().int().min(1).max(12).default(4), max_turns: z.number().int().min(1).max(100).default(24), max_tool_calls: z.number().int().min(1).max(200).default(40), timeout_sec: z.number().int().min(10).max(1800).default(300), context_budget: z.number().int().min(4000).max(200000).default(48000), source_episode_limit: z.number().int().nonnegative().default(0), temperature: z.number().min(0).max(1).default(0.2), max_tokens: z.number().int().min(256).max(16384).default(4096) }).strict();
export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export type SessionData = { threads: Thread[]; runs: RunRecord[]; steering: SteeringItem[]; messages: Message[]; events: RuntimeEvent[]; config: SessionConfig; description: string };
export type Session = { id: string; name: string; created_at: string; updated_at: string; data: SessionData };
export type WorkspaceSnapshot = { sessions: Session[]; providers: { openai: boolean; anthropic: boolean }; workspace: string };
export const jsonSchema = (schema: z.ZodType): Record<string, unknown> => z.toJSONSchema(schema) as Record<string, unknown>;
export function addUsage(a: Usage, b: Usage): Usage { return { input: a.input + b.input, output: a.output + b.output, total: a.total + b.total }; }
