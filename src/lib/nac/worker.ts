import { z } from "zod";
import { episodeSchema, errorSchema, sessionConfigSchema, threadSchema, usageSchema, type Session } from "./models";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type IssuePath = Array<string | number>;

function addIssue(ctx: z.RefinementCtx, path: IssuePath, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function addDateOrderIssue(ctx: z.RefinementCtx, earlier: string, later: string | undefined, laterPath: IssuePath, message: string): void {
  if (later !== undefined && Date.parse(later) < Date.parse(earlier)) addIssue(ctx, laterPath, message);
}

function addDateCeilingIssue(ctx: z.RefinementCtx, value: string | undefined, ceiling: string | undefined, valuePath: IssuePath, message: string): void {
  if (value !== undefined && ceiling !== undefined && Date.parse(value) > Date.parse(ceiling)) addIssue(ctx, valuePath, message);
}

function valuesDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date || right instanceof Date) return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!valuesDeepEqual(left[index], right[index])) return false;
    return true;
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
      if (!valuesDeepEqual(leftRecord[key], rightRecord[key])) return false;
    }
    return true;
  }
  return false;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]));
const nonEmptyStringSchema = z.string().min(1);
const nonnegativeFiniteNumberSchema = z.number().finite().nonnegative();
const nonnegativeIntegerSchema = z.number().finite().int().nonnegative();
const callStatusSchema = z.enum(["complete", "partial", "failed", "skipped"]);

const toolCallSchema = z.object({ id: nonEmptyStringSchema, name: nonEmptyStringSchema, arguments: z.record(z.string(), jsonValueSchema) }).strict();
const messageSchema = z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string(), tool_calls: z.array(toolCallSchema).min(1).optional(), tool_call_id: nonEmptyStringSchema.optional() }).strict().superRefine((message, ctx) => {
  if (message.role === "tool") {
    if (message.tool_call_id === undefined) addIssue(ctx, ["tool_call_id"], "Tool messages must include tool_call_id");
  } else if (message.tool_call_id !== undefined) {
    addIssue(ctx, ["tool_call_id"], "Only tool messages can include tool_call_id");
  }
  if (message.role !== "assistant" && message.tool_calls !== undefined) addIssue(ctx, ["tool_calls"], "Only assistant messages can include tool_calls");
});
const callResultSchema = z.object({ call_id: nonEmptyStringSchema, thread_name: nonEmptyStringSchema, status: callStatusSchema, episode: episodeSchema.optional(), error: errorSchema.optional(), failed_dependencies: z.array(nonEmptyStringSchema).optional(), duration_ms: nonnegativeFiniteNumberSchema, token_usage: usageSchema }).strict();
const batchReportSchema = z.object({ batch_id: nonEmptyStringSchema, rationale: z.string(), started_at: z.string().datetime(), finished_at: z.string().datetime().optional(), status: z.enum(["running", "complete"]), calls: z.array(callResultSchema), counts: z.object({ complete: nonnegativeIntegerSchema, partial: nonnegativeIntegerSchema, failed: nonnegativeIntegerSchema, skipped: nonnegativeIntegerSchema }).strict(), token_usage: usageSchema, duration_ms: nonnegativeFiniteNumberSchema }).strict();
const runSchema = z.object({ run_id: nonEmptyStringSchema, prompt: z.string(), started_at: z.string().datetime(), finished_at: z.string().datetime().optional(), status: z.enum(["running", "complete", "failed", "cancelled"]), phase: z.enum(["planning", "dispatching", "finished"]), model: nonEmptyStringSchema, batches: z.array(batchReportSchema), token_usage: usageSchema, final_answer: z.string().optional(), error: errorSchema.optional(), cancel_requested: z.boolean(), heartbeat_at: z.string().datetime() }).strict();
const steeringSchema = z.object({ id: nonEmptyStringSchema, text: z.string().max(12000), thread_name: nonEmptyStringSchema.optional(), queued_at: z.string().datetime(), consumed_at: z.string().datetime().optional(), consumption_point: z.string().optional() }).strict();
const eventSchema = z.object({ id: nonEmptyStringSchema, type: nonEmptyStringSchema, message: z.string(), created_at: z.string().datetime(), session_id: nonEmptyStringSchema, run_id: nonEmptyStringSchema.optional(), batch_id: nonEmptyStringSchema.optional(), call_id: nonEmptyStringSchema.optional(), thread_id: nonEmptyStringSchema.optional(), episode_id: nonEmptyStringSchema.optional(), details: z.record(z.string(), jsonValueSchema).optional() }).strict();

const baseSessionBundleSchema = z.object({ format: z.literal("nested-session"), version: z.literal(1), exported_at: z.string().datetime(), session: z.object({ id: z.string().regex(/^ses_[a-zA-Z0-9_-]+$/), name: z.string().trim().min(1).max(100), created_at: z.string().datetime(), updated_at: z.string().datetime(), data: z.object({ threads: z.array(threadSchema).max(1000), runs: z.array(runSchema).max(10000), steering: z.array(steeringSchema).max(10000), messages: z.array(messageSchema).max(100000), events: z.array(eventSchema).max(1000000), config: sessionConfigSchema, description: z.string().max(24000) }).strict() }).strict() }).strict();

type ParsedSessionBundle = z.infer<typeof baseSessionBundleSchema>;
type CallStatus = z.infer<typeof callStatusSchema>;
type EpisodeInfo = { threadId: string; sequence: number; episode: unknown };
type BatchInfo = { runId: string };
type CallInfo = { batchId: string; threadName: string; status: CallStatus };

function validateParsedBundle(bundle: ParsedSessionBundle, ctx: z.RefinementCtx): void {
  const session = bundle.session;
  const data = session.data;
  const threadNames = new Set<string>();
  const threadIds = new Set<string>();
  const threadNameToThreadId = new Map<string, string>();
  const episodeIds = new Set<string>();
  const episodeInfoById = new Map<string, EpisodeInfo>();
  const runIds = new Set<string>();
  const batchIds = new Set<string>();
  const batchInfoById = new Map<string, BatchInfo>();
  const callIds = new Set<string>();
  const callInfoById = new Map<string, CallInfo>();
  const steeringIds = new Set<string>();
  const eventIds = new Set<string>();
  const assistantToolCallIds = new Set<string>();
  const toolResponseIds = new Set<string>();

  addDateOrderIssue(ctx, session.created_at, session.updated_at, ["session", "updated_at"], "Imported session updated_at must not be earlier than created_at");
  addDateOrderIssue(ctx, session.created_at, bundle.exported_at, ["exported_at"], "Imported bundle exported_at must not be earlier than session created_at");
  addDateOrderIssue(ctx, session.updated_at, bundle.exported_at, ["exported_at"], "Imported bundle exported_at must not be earlier than session updated_at");

  for (const [threadIndex, thread] of data.threads.entries()) {
    const threadPath: IssuePath = ["session", "data", "threads", threadIndex];

    if (threadNames.has(thread.name)) addIssue(ctx, [...threadPath, "name"], "Imported thread names must be unique");
    else {
      threadNames.add(thread.name);
      threadNameToThreadId.set(thread.name, thread.thread_id);
    }

    if (threadIds.has(thread.thread_id)) addIssue(ctx, [...threadPath, "thread_id"], "Imported thread ids must be unique");
    else threadIds.add(thread.thread_id);

    for (const [episodeIndex, episode] of thread.episodes.entries()) {
      const episodePath: IssuePath = [...threadPath, "episodes", episodeIndex];

      if (episode.thread_id !== thread.thread_id) addIssue(ctx, [...episodePath, "thread_id"], "Imported episodes must have matching thread ids");
      if (episode.sequence !== episodeIndex + 1) addIssue(ctx, [...episodePath, "sequence"], "Imported episodes must have gap-free one-based sequences");

      if (episodeIds.has(episode.episode_id)) addIssue(ctx, [...episodePath, "episode_id"], "Imported episode ids must be unique");
      else {
        episodeIds.add(episode.episode_id);
        episodeInfoById.set(episode.episode_id, { threadId: episode.thread_id, sequence: episode.sequence, episode });
      }
    }
  }

  for (const [threadIndex, thread] of data.threads.entries()) {
    const threadPath: IssuePath = ["session", "data", "threads", threadIndex];
    for (const [episodeIndex, episode] of thread.episodes.entries()) {
      const episodePath: IssuePath = [...threadPath, "episodes", episodeIndex];
      const sourceEpisodeRefs = episode.source_episode_refs ?? [];
      const seenSourceRefs = new Set<string>();

      for (const [sourceIndex, ref] of sourceEpisodeRefs.entries()) {
        const sourcePath: IssuePath = [...episodePath, "source_episode_refs", sourceIndex];
        const referencedEpisode = episodeInfoById.get(ref);

        if (seenSourceRefs.has(ref)) addIssue(ctx, sourcePath, "Imported source episode references must be unique within an episode");
        else seenSourceRefs.add(ref);

        if (referencedEpisode === undefined) addIssue(ctx, sourcePath, `Imported source episode reference is missing: ${ref}`);
        else if (referencedEpisode.threadId === episode.thread_id && referencedEpisode.sequence >= episode.sequence) addIssue(ctx, sourcePath, "Imported source episode references in the same thread must point to earlier episodes");
      }
    }
  }

  for (const [runIndex, run] of data.runs.entries()) {
    const runPath: IssuePath = ["session", "data", "runs", runIndex];

    if (runIds.has(run.run_id)) addIssue(ctx, [...runPath, "run_id"], "Imported run ids must be unique");
    else runIds.add(run.run_id);

    addDateOrderIssue(ctx, run.started_at, run.finished_at, [...runPath, "finished_at"], "Imported run finished_at must not be earlier than started_at");
    addDateOrderIssue(ctx, run.started_at, run.heartbeat_at, [...runPath, "heartbeat_at"], "Imported run heartbeat_at must not be earlier than started_at");
    addDateCeilingIssue(ctx, run.heartbeat_at, run.finished_at, [...runPath, "heartbeat_at"], "Imported run heartbeat_at must not be later than finished_at");

    if (run.status === "running") {
      if (run.finished_at !== undefined) addIssue(ctx, [...runPath, "finished_at"], "Imported running runs must not have finished_at");
      if (run.phase === "finished") addIssue(ctx, [...runPath, "phase"], "Imported running runs must not have finished phase");
    } else {
      if (run.finished_at === undefined) addIssue(ctx, [...runPath, "finished_at"], "Imported terminal runs must have finished_at");
      if (run.phase !== "finished") addIssue(ctx, [...runPath, "phase"], "Imported terminal runs must have finished phase");
    }

    if (run.status === "failed") {
      if (run.error === undefined) addIssue(ctx, [...runPath, "error"], "Imported failed runs must include an error");
    } else if ((run.status === "running" || run.status === "complete") && run.error !== undefined) {
      addIssue(ctx, [...runPath, "error"], "Imported running and complete runs must not include an error");
    }

    for (const [batchIndex, batch] of run.batches.entries()) {
      const batchPath: IssuePath = [...runPath, "batches", batchIndex];

      if (batchIds.has(batch.batch_id)) addIssue(ctx, [...batchPath, "batch_id"], "Imported batch ids must be unique");
      else {
        batchIds.add(batch.batch_id);
        batchInfoById.set(batch.batch_id, { runId: run.run_id });
      }

      addDateOrderIssue(ctx, run.started_at, batch.started_at, [...batchPath, "started_at"], "Imported batch started_at must not be earlier than its run started_at");
      addDateOrderIssue(ctx, batch.started_at, batch.finished_at, [...batchPath, "finished_at"], "Imported batch finished_at must not be earlier than started_at");
      addDateCeilingIssue(ctx, batch.finished_at, run.finished_at, [...batchPath, "finished_at"], "Imported batch finished_at must not be later than its run finished_at");

      if (batch.status === "running") {
        if (batch.finished_at !== undefined) addIssue(ctx, [...batchPath, "finished_at"], "Imported running batches must not have finished_at");
      } else if (batch.finished_at === undefined) {
        addIssue(ctx, [...batchPath, "finished_at"], "Imported complete batches must have finished_at");
      }

      if (run.status !== "running" && batch.status === "running") addIssue(ctx, [...batchPath, "status"], "Imported terminal runs must not contain running batches");

      const counts = { complete: 0, partial: 0, failed: 0, skipped: 0 };

      for (const [callIndex, call] of batch.calls.entries()) {
        const callPath: IssuePath = [...batchPath, "calls", callIndex];
        counts[call.status] += 1;

        if (callIds.has(call.call_id)) addIssue(ctx, [...callPath, "call_id"], "Imported call ids must be unique");
        else {
          callIds.add(call.call_id);
          callInfoById.set(call.call_id, { batchId: batch.batch_id, threadName: call.thread_name, status: call.status });
        }

        const expectedThreadId = threadNameToThreadId.get(call.thread_name);
        if (expectedThreadId === undefined) addIssue(ctx, [...callPath, "thread_name"], `Imported call references missing thread name: ${call.thread_name}`);

        if (call.status === "complete") {
          if (call.episode === undefined) addIssue(ctx, [...callPath, "episode"], "Imported complete calls must include an episode");
          if (call.error !== undefined) addIssue(ctx, [...callPath, "error"], "Imported complete calls must not include an error");
          if ((call.failed_dependencies ?? []).length > 0) addIssue(ctx, [...callPath, "failed_dependencies"], "Imported complete calls must not include failed dependencies");
        } else if (call.status === "partial") {
          if (call.episode === undefined && call.error === undefined) addIssue(ctx, callPath, "Imported partial calls must include an episode or an error");
        } else if (call.status === "failed") {
          if (call.error === undefined) addIssue(ctx, [...callPath, "error"], "Imported failed calls must include an error");
          if (call.episode !== undefined) addIssue(ctx, [...callPath, "episode"], "Imported failed calls must not include an episode");
        } else {
          if (call.episode !== undefined) addIssue(ctx, [...callPath, "episode"], "Imported skipped calls must not include an episode");
          if (call.failed_dependencies === undefined || call.failed_dependencies.length === 0) addIssue(ctx, [...callPath, "failed_dependencies"], "Imported skipped calls must include failed dependencies");
        }

        if (call.episode !== undefined) {
          if (expectedThreadId !== undefined && call.episode.thread_id !== expectedThreadId) addIssue(ctx, [...callPath, "episode", "thread_id"], "Imported call result episode thread_id must match call thread_name");
          const canonicalEpisode = episodeInfoById.get(call.episode.episode_id);
          if (canonicalEpisode === undefined) {
            addIssue(ctx, [...callPath, "episode", "episode_id"], "Imported call result episode must exist in session threads");
          } else {
            if (call.episode.thread_id !== canonicalEpisode.threadId) addIssue(ctx, [...callPath, "episode", "thread_id"], "Imported call result episode thread_id must match the stored episode");
            if (call.episode.sequence !== canonicalEpisode.sequence) addIssue(ctx, [...callPath, "episode", "sequence"], "Imported call result episode sequence must match the stored episode");
            if (!valuesDeepEqual(call.episode, canonicalEpisode.episode)) addIssue(ctx, [...callPath, "episode"], "Imported call result episode must match the episode stored in its thread");
          }
        }
      }

      if (batch.counts.complete !== counts.complete || batch.counts.partial !== counts.partial || batch.counts.failed !== counts.failed || batch.counts.skipped !== counts.skipped) addIssue(ctx, [...batchPath, "counts"], "Imported batch counts must match call statuses");
    }
  }

  for (const [runIndex, run] of data.runs.entries()) {
    const runPath: IssuePath = ["session", "data", "runs", runIndex];
    for (const [batchIndex, batch] of run.batches.entries()) {
      const batchPath: IssuePath = [...runPath, "batches", batchIndex];
      for (const [callIndex, call] of batch.calls.entries()) {
        if (call.failed_dependencies === undefined) continue;
        const callPath: IssuePath = [...batchPath, "calls", callIndex];
        const seenDependencies = new Set<string>();

        for (const [dependencyIndex, dependency] of call.failed_dependencies.entries()) {
          const dependencyPath: IssuePath = [...callPath, "failed_dependencies", dependencyIndex];
          const dependencyInfo = callInfoById.get(dependency);

          if (seenDependencies.has(dependency)) addIssue(ctx, dependencyPath, "Imported failed dependencies must be unique within a call");
          else seenDependencies.add(dependency);

          if (dependency === call.call_id) addIssue(ctx, dependencyPath, "Imported failed dependencies must not reference the same call");
          if (dependencyInfo === undefined) {
            addIssue(ctx, dependencyPath, `Imported failed dependency is missing: ${dependency}`);
          } else {
            if (dependencyInfo.status === "complete") addIssue(ctx, dependencyPath, "Imported failed dependencies must not reference complete calls");
            const dependencyBatchInfo = batchInfoById.get(dependencyInfo.batchId);
            if (dependencyBatchInfo !== undefined && dependencyBatchInfo.runId !== run.run_id) addIssue(ctx, dependencyPath, "Imported failed dependencies must reference calls in the same run");
          }
        }
      }
    }
  }

  for (const [steeringIndex, steering] of data.steering.entries()) {
    const steeringPath: IssuePath = ["session", "data", "steering", steeringIndex];

    if (steeringIds.has(steering.id)) addIssue(ctx, [...steeringPath, "id"], "Imported steering ids must be unique");
    else steeringIds.add(steering.id);

    if (steering.thread_name !== undefined && !threadNameToThreadId.has(steering.thread_name)) addIssue(ctx, [...steeringPath, "thread_name"], `Imported steering references missing thread name: ${steering.thread_name}`);
    addDateOrderIssue(ctx, steering.queued_at, steering.consumed_at, [...steeringPath, "consumed_at"], "Imported steering consumed_at must not be earlier than queued_at");
    if (steering.consumed_at === undefined && steering.consumption_point !== undefined) addIssue(ctx, [...steeringPath, "consumption_point"], "Imported unconsumed steering must not include consumption_point");
  }

  for (const [messageIndex, message] of data.messages.entries()) {
    const messagePath: IssuePath = ["session", "data", "messages", messageIndex];

    if (message.role === "assistant" && message.tool_calls !== undefined) {
      for (const [toolCallIndex, toolCall] of message.tool_calls.entries()) {
        const toolCallPath: IssuePath = [...messagePath, "tool_calls", toolCallIndex, "id"];
        if (assistantToolCallIds.has(toolCall.id)) addIssue(ctx, toolCallPath, "Imported assistant tool call ids must be unique");
        else assistantToolCallIds.add(toolCall.id);
      }
    }

    if (message.role === "tool" && message.tool_call_id !== undefined) {
      if (toolResponseIds.has(message.tool_call_id)) addIssue(ctx, [...messagePath, "tool_call_id"], "Imported tool response messages must reference unique tool_call_id values");
      else toolResponseIds.add(message.tool_call_id);
    }
  }

  for (const [messageIndex, message] of data.messages.entries()) {
    if (message.role === "tool" && message.tool_call_id !== undefined && !assistantToolCallIds.has(message.tool_call_id)) addIssue(ctx, ["session", "data", "messages", messageIndex, "tool_call_id"], `Imported tool message references missing assistant tool call: ${message.tool_call_id}`);
  }

  for (const [eventIndex, event] of data.events.entries()) {
    const eventPath: IssuePath = ["session", "data", "events", eventIndex];

    if (eventIds.has(event.id)) addIssue(ctx, [...eventPath, "id"], "Imported event ids must be unique");
    else eventIds.add(event.id);

    if (event.session_id !== session.id) addIssue(ctx, [...eventPath, "session_id"], "Imported event session_id must match imported session id");
    addDateOrderIssue(ctx, session.created_at, event.created_at, [...eventPath, "created_at"], "Imported event created_at must not be earlier than session created_at");
    addDateCeilingIssue(ctx, event.created_at, bundle.exported_at, [...eventPath, "created_at"], "Imported event created_at must not be later than exported_at");

    if (event.run_id !== undefined && !runIds.has(event.run_id)) addIssue(ctx, [...eventPath, "run_id"], `Imported event references missing run id: ${event.run_id}`);

    if (event.batch_id !== undefined) {
      const batchInfo = batchInfoById.get(event.batch_id);
      if (batchInfo === undefined) addIssue(ctx, [...eventPath, "batch_id"], `Imported event references missing batch id: ${event.batch_id}`);
      else if (event.run_id !== undefined && batchInfo.runId !== event.run_id) addIssue(ctx, [...eventPath, "batch_id"], "Imported event batch_id must belong to event run_id");
    }

    if (event.call_id !== undefined) {
      const callInfo = callInfoById.get(event.call_id);
      if (callInfo === undefined) {
        addIssue(ctx, [...eventPath, "call_id"], `Imported event references missing call id: ${event.call_id}`);
      } else {
        if (event.batch_id !== undefined && callInfo.batchId !== event.batch_id) addIssue(ctx, [...eventPath, "call_id"], "Imported event call_id must belong to event batch_id");
        const callBatchInfo = batchInfoById.get(callInfo.batchId);
        if (event.run_id !== undefined && callBatchInfo !== undefined && callBatchInfo.runId !== event.run_id) addIssue(ctx, [...eventPath, "call_id"], "Imported event call_id must belong to event run_id");
        const callThreadId = threadNameToThreadId.get(callInfo.threadName);
        if (event.thread_id !== undefined && callThreadId !== undefined && event.thread_id !== callThreadId) addIssue(ctx, [...eventPath, "thread_id"], "Imported event thread_id must match event call_id thread");
      }
    }

    if (event.thread_id !== undefined && !threadIds.has(event.thread_id)) addIssue(ctx, [...eventPath, "thread_id"], `Imported event references missing thread id: ${event.thread_id}`);

    if (event.episode_id !== undefined) {
      const episodeInfo = episodeInfoById.get(event.episode_id);
      if (episodeInfo === undefined) {
        addIssue(ctx, [...eventPath, "episode_id"], `Imported event references missing episode id: ${event.episode_id}`);
      } else {
        if (event.thread_id !== undefined && episodeInfo.threadId !== event.thread_id) addIssue(ctx, [...eventPath, "episode_id"], "Imported event episode_id must belong to event thread_id");
        if (event.call_id !== undefined) {
          const callInfo = callInfoById.get(event.call_id);
          const callThreadId = callInfo === undefined ? undefined : threadNameToThreadId.get(callInfo.threadName);
          if (callThreadId !== undefined && episodeInfo.threadId !== callThreadId) addIssue(ctx, [...eventPath, "episode_id"], "Imported event episode_id must belong to event call_id thread");
        }
      }
    }
  }
}

export const sessionBundleSchema = baseSessionBundleSchema.superRefine((bundle, ctx) => {
  validateParsedBundle(bundle, ctx);
});

export function validateBundle(input: unknown): Session {
  const { session } = sessionBundleSchema.parse(input);
  return session;
}
