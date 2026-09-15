import { z } from "zod";
import { episodeSchema, errorSchema, sessionConfigSchema, threadSchema, usageSchema, type Session } from "./models";

const toolCallSchema = z.object({ id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict();
const messageSchema = z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string(), tool_calls: z.array(toolCallSchema).optional(), tool_call_id: z.string().optional() }).strict();
const callResultSchema = z.object({ call_id: z.string(), thread_name: z.string(), status: z.enum(["complete", "partial", "failed", "skipped"]), episode: episodeSchema.optional(), error: errorSchema.optional(), failed_dependencies: z.array(z.string()).optional(), duration_ms: z.number().nonnegative(), token_usage: usageSchema }).strict();
const batchReportSchema = z.object({ batch_id: z.string(), rationale: z.string(), started_at: z.string().datetime(), finished_at: z.string().datetime().optional(), status: z.enum(["running", "complete"]), calls: z.array(callResultSchema), counts: z.object({ complete: z.number().int().nonnegative(), partial: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).strict(), token_usage: usageSchema, duration_ms: z.number().nonnegative() }).strict();
const runSchema = z.object({ run_id: z.string(), prompt: z.string(), started_at: z.string().datetime(), finished_at: z.string().datetime().optional(), status: z.enum(["running", "complete", "failed", "cancelled"]), phase: z.enum(["planning", "dispatching", "finished"]), model: z.string(), batches: z.array(batchReportSchema), token_usage: usageSchema, final_answer: z.string().optional(), error: errorSchema.optional(), cancel_requested: z.boolean(), heartbeat_at: z.string().datetime() }).strict();
const steeringSchema = z.object({ id: z.string(), text: z.string().max(12000), thread_name: z.string().optional(), queued_at: z.string().datetime(), consumed_at: z.string().datetime().optional(), consumption_point: z.string().optional() }).strict();
const eventSchema = z.object({ id: z.string(), type: z.string(), message: z.string(), created_at: z.string().datetime(), session_id: z.string(), run_id: z.string().optional(), batch_id: z.string().optional(), call_id: z.string().optional(), thread_id: z.string().optional(), episode_id: z.string().optional(), details: z.record(z.string(), z.unknown()).optional() }).strict();
export const sessionBundleSchema = z.object({ format: z.literal("nested-session"), version: z.literal(1), exported_at: z.string().datetime(), session: z.object({ id: z.string().regex(/^ses_[a-zA-Z0-9_-]+$/), name: z.string().trim().min(1).max(100), created_at: z.string().datetime(), updated_at: z.string().datetime(), data: z.object({ threads: z.array(threadSchema).max(1000), runs: z.array(runSchema).max(10000), steering: z.array(steeringSchema).max(10000), messages: z.array(messageSchema).max(100000), events: z.array(eventSchema).max(1000000), config: sessionConfigSchema, description: z.string().max(24000) }).strict() }).strict() }).strict();
export function validateBundle(input: unknown): Session {
  const { session } = sessionBundleSchema.parse(input);
  const names = new Set<string>();
  const threadIds = new Set<string>();
  const episodeIds = new Set<string>();
  for (const thread of session.data.threads) {
    if (names.has(thread.name) || threadIds.has(thread.thread_id)) throw new Error("Imported thread names and ids must be unique");
    names.add(thread.name); threadIds.add(thread.thread_id);
    for (const [index, episode] of thread.episodes.entries()) {
      if (episode.thread_id !== thread.thread_id || episode.sequence !== index + 1) throw new Error("Imported episodes must have matching thread ids and gap-free sequences");
      if (episodeIds.has(episode.episode_id)) throw new Error("Imported episode ids must be unique");
      episodeIds.add(episode.episode_id);
    }
  }
  for (const thread of session.data.threads) for (const episode of thread.episodes) for (const ref of episode.source_episode_refs) if (!episodeIds.has(ref)) throw new Error(`Imported source episode reference is missing: ${ref}`);
  return session;
}
