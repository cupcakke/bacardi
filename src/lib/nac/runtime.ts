import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { redact, workspaceRoot } from "./config";
import { type SourceEpisode } from "./context";
import { addUsage, batchSchema, emptyUsage, jsonSchema, type BatchPlan, type BatchReport, type CallResult, type EpisodeError, type Message, type RunRecord, type ThreadCall } from "./models";
import { ORCHESTRATOR_PROMPT } from "./prompts";
import { HTTPProvider, type ToolDefinition } from "./providers";
import { mapConcurrent, topologicalWaves } from "./scheduler";
import { createThread, event, getSession, id, mutateSession, now } from "./store";
import { executeWorker, WorkerFailure } from "./worker";

const nameSchema = z.object({ thread_name: z.string() }).strict();
const episodeIdSchema = z.object({ episode_id: z.string() }).strict();
const noArgs = z.object({}).strict();
export const orchestratorTools: ToolDefinition[] = [
  { name: "list_threads", description: "List thread names, charters, statuses, ids, and episode counts. Read-only.", input_schema: jsonSchema(noArgs) },
  { name: "get_thread_episodes", description: "Retrieve retained episodes for a named thread, in sequence order. Read-only.", input_schema: jsonSchema(nameSchema) },
  { name: "get_episode", description: "Retrieve one episode by id. Read-only.", input_schema: jsonSchema(episodeIdSchema) },
  { name: "get_session_info", description: "Read session metadata, configuration, and run summaries.", input_schema: jsonSchema(noArgs) },
  { name: "dispatch_batch", description: "Dispatch a batch of thread calls. Executes to completion; returns all episodes and errors.", input_schema: jsonSchema(batchSchema) },
];
const failure = (error: unknown, advanced = false): EpisodeError => ({ type: error instanceof Error ? error.name : "RuntimeError", message: redact(error instanceof Error ? error.message : String(error)), recoverable: true, environment_may_have_advanced: advanced });
export async function reserveRun(sessionId: string, prompt: string): Promise<string> {
  return mutateSession(sessionId, (session) => {
    if (session.data.runs.some((run) => run.status === "running")) throw new Error("This session already has a run in progress");
    const runId = id("run");
    const run: RunRecord = { run_id: runId, prompt, started_at: now(), status: "running", phase: "planning", model: session.data.config.orchestrator_model, batches: [], token_usage: emptyUsage(), cancel_requested: false, heartbeat_at: now() };
    session.data.runs.push(run);
    if (!session.data.messages.length) session.data.messages.push({ role: "system", content: ORCHESTRATOR_PROMPT });
    session.data.messages.push({ role: "user", content: prompt });
    event(session.data, sessionId, "run.started", "Orchestrator started planning", { run_id: runId });
    return runId;
  });
}
export async function queueSteering(sessionId: string, text: string, threadName?: string): Promise<void> {
  await mutateSession(sessionId, (session) => {
    if (threadName && !session.data.threads.some((thread) => thread.name === threadName)) throw new Error("Thread not found");
    if (!threadName && !session.data.runs.some((run) => run.status === "running")) throw new Error("Start a run before queuing orchestrator steering");
    session.data.steering.push({ id: id("str"), text, thread_name: threadName, queued_at: now() });
    event(session.data, sessionId, "steering.queued", threadName ? `Steering queued for ${threadName}'s next dispatch` : "Steering queued for the next planning turn", { details: { text, thread_name: threadName } });
  });
}
async function executeCall(sessionId: string, runId: string, batchId: string, call: ThreadCall): Promise<CallResult> {
  const started = Date.now();
  let threadId: string | undefined;
  let environmentMayHaveAdvanced = false;
  try {
    const prepared = await mutateSession(sessionId, (session) => {
      const run = session.data.runs.find((item) => item.run_id === runId);
      if (run?.cancel_requested) return null;
      let thread = session.data.threads.find((item) => item.name === call.thread_name);
      if (!thread) {
        if (!call.create_if_missing) throw new Error(`Thread ${call.thread_name} does not exist`);
        if (!call.thread_system_prompt) throw new Error("thread_system_prompt is required when creating a new thread");
        thread = createThread(call.thread_name, call.thread_system_prompt);
        if (call.tool_policy) {
          if (call.tool_policy.allow_shell || call.tool_policy.allow_network) throw new Error("The orchestrator cannot grant shell or network access. Configure those permissions explicitly in the thread settings.");
          thread.tool_policy = call.tool_policy;
        }
        session.data.threads.push(thread);
        event(session.data, sessionId, "thread.created", `${thread.name} workstream created`, { run_id: runId, thread_id: thread.thread_id });
      }
      const sources: SourceEpisode[] = [];
      const seen = new Set<string>();
      for (const name of call.source_threads) {
        const source = session.data.threads.find((item) => item.name === name);
        if (!source) throw new Error(`Unknown source thread: ${name}`);
        if (source.thread_id === thread.thread_id) continue;
        const limit = session.data.config.source_episode_limit;
        for (const episode of limit ? source.episodes.slice(-limit) : source.episodes) if (!seen.has(episode.episode_id)) { seen.add(episode.episode_id); sources.push({ thread_name: name, episode }); }
      }
      for (const episodeId of call.source_episodes) {
        const source = session.data.threads.find((item) => item.episodes.some((episode) => episode.episode_id === episodeId));
        const episode = source?.episodes.find((item) => item.episode_id === episodeId);
        if (!source || !episode) throw new Error(`Unknown source episode: ${episodeId}`);
        if (source.thread_id !== thread.thread_id && !seen.has(episodeId)) { seen.add(episodeId); sources.push({ thread_name: source.name, episode }); }
      }
      let action = call.requested_action;
      for (const item of session.data.steering.filter((item) => item.thread_name === thread.name && !item.consumed_at)) {
        action += `\n\nTHREAD STEERING\n${item.text}`;
        item.consumed_at = now();
        item.consumption_point = call.call_id;
        event(session.data, sessionId, "steering.consumed", `Thread steering consumed by ${call.call_id}`, { run_id: runId, call_id: call.call_id });
      }
      thread.status = "running";
      thread.updated_at = now();
      event(session.data, sessionId, "call.started", `${thread.name} started its bounded task`, { run_id: runId, batch_id: batchId, call_id: call.call_id, thread_id: thread.thread_id });
      return { thread: structuredClone(thread), sources, action, config: { ...session.data.config, worker_model: call.model ?? session.data.config.worker_model, max_turns: Math.min(call.max_turns ?? session.data.config.max_turns, session.data.config.max_turns), timeout_sec: Math.min(call.timeout_sec ?? session.data.config.timeout_sec, session.data.config.timeout_sec) } };
    });
    if (!prepared) return { call_id: call.call_id, thread_name: call.thread_name, status: "skipped", error: failure(new Error("Run cancellation requested")), duration_ms: 0, token_usage: emptyUsage() };
    threadId = prepared.thread.thread_id;
    const workspace = path.join(workspaceRoot(), sessionId);
    await mkdir(workspace, { recursive: true });
    const result = await executeWorker(prepared.thread, prepared.action, prepared.sources, prepared.config, workspace, async (type, details) => {
      if (details.environment_may_have_advanced === true || details.is_mutating === true) environmentMayHaveAdvanced = true;
      await mutateSession(sessionId, (session) => { event(session.data, sessionId, type, `${prepared.thread.name}: ${String(details.tool)}`, { run_id: runId, batch_id: batchId, call_id: call.call_id, thread_id: threadId, details }); });
    });
    return mutateSession(sessionId, (session) => {
      const thread = session.data.threads.find((item) => item.thread_id === threadId);
      if (!thread) throw new Error("Target thread disappeared during execution");
      const episode = { ...result, episode_id: id("ep"), sequence: (thread.episodes.at(-1)?.sequence ?? 0) + 1 };
      thread.episodes.push(episode);
      thread.status = "complete";
      thread.updated_at = now();
      const callResult: CallResult = { call_id: call.call_id, thread_name: call.thread_name, status: episode.status, episode, duration_ms: episode.duration_ms, token_usage: episode.token_usage };
      const batch = session.data.runs.find((run) => run.run_id === runId)?.batches.find((item) => item.batch_id === batchId);
      batch?.calls.push(callResult);
      event(session.data, sessionId, "episode.stored", `${thread.name} handed off episode ${episode.sequence}`, { run_id: runId, batch_id: batchId, call_id: call.call_id, thread_id: threadId, episode_id: episode.episode_id });
      event(session.data, sessionId, "call.finished", `${thread.name} ${episode.status}`, { run_id: runId, batch_id: batchId, call_id: call.call_id });
      return callResult;
    });
  } catch (error) {
    const detail = error instanceof WorkerFailure ? error.detail : failure(error, environmentMayHaveAdvanced);
    const result: CallResult = { call_id: call.call_id, thread_name: call.thread_name, status: "failed", error: detail, duration_ms: error instanceof WorkerFailure ? error.duration : Date.now() - started, token_usage: error instanceof WorkerFailure ? error.usage : emptyUsage() };
    await mutateSession(sessionId, (session) => {
      const thread = session.data.threads.find((item) => item.thread_id === threadId);
      if (thread) { thread.status = "failed"; thread.updated_at = now(); }
      session.data.runs.find((run) => run.run_id === runId)?.batches.find((batch) => batch.batch_id === batchId)?.calls.push(result);
      event(session.data, sessionId, "call.failed", `${call.thread_name}: ${detail.message}${detail.environment_may_have_advanced ? " Environment may have advanced without any persistent thread history being recorded. Verify the actual workspace before retrying." : " No episode was appended."}`, { run_id: runId, batch_id: batchId, call_id: call.call_id, thread_id: threadId, details: { error: detail } });
    });
    return result;
  }
}
export async function executeBatch(sessionId: string, runId: string, plan: BatchPlan): Promise<BatchReport> {
  const waves = topologicalWaves(plan.calls);
  const batchId = id("bat");
  const started = Date.now();
  const report: BatchReport = { batch_id: batchId, rationale: plan.rationale ?? "", started_at: now(), status: "running", calls: [], counts: { complete: 0, partial: 0, failed: 0, skipped: 0 }, token_usage: emptyUsage(), duration_ms: 0 };
  const parallel = await mutateSession(sessionId, (session) => {
    const run = session.data.runs.find((item) => item.run_id === runId);
    if (!run || run.phase === "dispatching") throw new Error("Cannot dispatch while a batch is in flight");
    run.phase = "dispatching";
    run.batches.push(structuredClone(report));
    event(session.data, sessionId, "batch.planned", `${plan.calls.length} bounded tasks dispatched`, { run_id: runId, batch_id: batchId, details: { rationale: plan.rationale ?? "" } });
    return session.data.config.max_parallel;
  });
  const results = new Map<string, CallResult>();
  for (const wave of waves) {
    await mapConcurrent(wave, parallel, async (call) => {
      const failedDependencies = call.depends_on.filter((dependency) => ["failed", "skipped"].includes(results.get(dependency)?.status ?? "failed"));
      if (failedDependencies.length) {
        const skipped: CallResult = { call_id: call.call_id, thread_name: call.thread_name, status: "skipped", failed_dependencies: failedDependencies, error: failure(new Error(`Failed dependencies: ${failedDependencies.join(", ")}`)), token_usage: emptyUsage(), duration_ms: 0 };
        results.set(call.call_id, skipped);
        await mutateSession(sessionId, (session) => { session.data.runs.find((run) => run.run_id === runId)?.batches.find((batch) => batch.batch_id === batchId)?.calls.push(skipped); event(session.data, sessionId, "call.skipped", `${call.thread_name} skipped: dependency failed`, { run_id: runId, batch_id: batchId, call_id: call.call_id }); });
      } else results.set(call.call_id, await executeCall(sessionId, runId, batchId, call));
    });
  }
  report.calls = plan.calls.map((call) => results.get(call.call_id)!);
  for (const result of report.calls) { report.counts[result.status]++; report.token_usage = addUsage(report.token_usage, result.token_usage); }
  report.duration_ms = Date.now() - started;
  report.finished_at = now();
  report.status = "complete";
  await mutateSession(sessionId, (session) => {
    const run = session.data.runs.find((item) => item.run_id === runId)!;
    run.batches[run.batches.findIndex((item) => item.batch_id === batchId)] = report;
    run.phase = "planning";
    run.token_usage = addUsage(run.token_usage, report.token_usage);
    event(session.data, sessionId, "batch.finished", `Batch complete: ${report.counts.complete} complete, ${report.counts.partial} partial, ${report.counts.failed} failed, ${report.counts.skipped} skipped`, { run_id: runId, batch_id: batchId });
  });
  return report;
}
export async function runOrchestrator(sessionId: string, runId: string, dryRun = false): Promise<void> {
  const heartbeat = setInterval(() => { mutateSession(sessionId, (session) => { const run = session.data.runs.find((item) => item.run_id === runId); if (run?.status === "running") run.heartbeat_at = now(); }).catch((error: unknown) => console.error(redact(String(error)))); }, 10000);
  try {
    const session = await getSession(sessionId);
    const provider = new HTTPProvider(session.data.config);
    for (let turn = 0; turn < 60; turn++) {
      const prepared = await mutateSession(sessionId, (current) => {
        const run = current.data.runs.find((item) => item.run_id === runId)!;
        if (run.cancel_requested) { run.status = "cancelled"; run.phase = "finished"; run.finished_at = now(); event(current.data, sessionId, "run.finished", "Run cancelled after in-flight work completed", { run_id: runId }); return null; }
        for (const item of current.data.steering.filter((item) => !item.thread_name && !item.consumed_at)) {
          current.data.messages.push({ role: "user", content: `STEERING\n${item.text}\nEND STEERING` });
          item.consumed_at = now(); item.consumption_point = `${runId}:turn:${turn + 1}`;
          event(current.data, sessionId, "steering.consumed", `Steering consumed at planning turn ${turn + 1}`, { run_id: runId });
        }
        event(current.data, sessionId, "orchestrator.turn", `Planning turn ${turn + 1}`, { run_id: runId });
        return structuredClone(current.data.messages);
      });
      if (!prepared) return;
      const response = await provider.chat(prepared, orchestratorTools, session.data.config.orchestrator_model, AbortSignal.timeout(session.data.config.timeout_sec * 1000));
      await mutateSession(sessionId, (current) => {
        current.data.messages.push({ role: "assistant", content: response.text, ...(response.tool_calls.length ? { tool_calls: response.tool_calls } : {}) });
        const run = current.data.runs.find((item) => item.run_id === runId)!;
        run.token_usage = addUsage(run.token_usage, response.usage);
      });
      if (!response.tool_calls.length) {
        await mutateSession(sessionId, (current) => { const run = current.data.runs.find((item) => item.run_id === runId)!; run.status = "complete"; run.phase = "finished"; run.final_answer = response.text; run.finished_at = now(); event(current.data, sessionId, "run.finished", "Run completed", { run_id: runId }); });
        return;
      }
      const invalidDispatch = response.tool_calls.some((call) => call.name === "dispatch_batch") && response.tool_calls.length !== 1;
      for (const call of response.tool_calls) {
        let result: unknown;
        try {
          if (invalidDispatch) throw new Error("dispatch_batch must be the only tool call in a planning turn; no tools in this turn were executed");
          if (call.name === "dispatch_batch") {
            const plan = batchSchema.parse(call.arguments);
            topologicalWaves(plan.calls);
            if (dryRun) {
              await mutateSession(sessionId, (current) => { const run = current.data.runs.find((item) => item.run_id === runId)!; run.status = "complete"; run.phase = "finished"; run.final_answer = JSON.stringify(plan, null, 2); run.finished_at = now(); current.data.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ dry_run: true, plan, workers_launched: 0 }) }); event(current.data, sessionId, "run.finished", "Dry run complete; no workers launched or workspace files changed", { run_id: runId }); });
              return;
            }
            result = await executeBatch(sessionId, runId, plan);
          } else {
            const current = await getSession(sessionId);
            if (call.name === "list_threads") { noArgs.parse(call.arguments); result = current.data.threads.map(({ thread_id, name, system_prompt, status, episodes }) => ({ thread_id, name, system_prompt, status, episode_count: episodes.length })); }
            else if (call.name === "get_thread_episodes") { const args = nameSchema.parse(call.arguments); const thread = current.data.threads.find((item) => item.name === args.thread_name); if (!thread) throw new Error("Thread not found"); result = thread.episodes; }
            else if (call.name === "get_episode") { const args = episodeIdSchema.parse(call.arguments); const episode = current.data.threads.flatMap((thread) => thread.episodes).find((item) => item.episode_id === args.episode_id); if (!episode) throw new Error("Episode not found"); result = episode; }
            else if (call.name === "get_session_info") { noArgs.parse(call.arguments); result = { session_id: current.id, name: current.name, description: current.data.description, config: current.data.config, created_at: current.created_at, runs: current.data.runs.map(({ run_id, prompt, status, final_answer }) => ({ run_id, prompt, status, final_answer })) }; }
            else throw new Error(`Orchestrator tool is not available: ${call.name}`);
          }
        } catch (error) { result = { error: failure(error) }; }
        const message: Message = { role: "tool", tool_call_id: call.id, content: redact(JSON.stringify(result)) };
        await mutateSession(sessionId, (current) => { current.data.messages.push(message); });
      }
    }
    throw new Error("Orchestrator exceeded its 60-turn safety limit");
  } catch (error) {
    await mutateSession(sessionId, (session) => {
      const run = session.data.runs.find((item) => item.run_id === runId)!;
      run.status = "failed"; run.phase = "finished"; run.error = failure(error); run.finished_at = now();
      const last = session.data.messages.at(-1);
      if (last?.role === "assistant" && last.tool_calls?.length) for (const call of last.tool_calls) session.data.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: run.error }) });
      event(session.data, sessionId, "run.finished", `Run failed: ${run.error.message}`, { run_id: runId });
    });
  } finally { clearInterval(heartbeat); }
}
export async function recoverInterruptedRuns(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session.data.runs.some((run) => run.status === "running" && Date.now() - Date.parse(run.heartbeat_at) > 120000)) return;
  await mutateSession(sessionId, (current) => {
    for (const run of current.data.runs) {
      if (run.status !== "running" || Date.now() - Date.parse(run.heartbeat_at) <= 120000) continue;
      run.status = "failed"; run.phase = "finished"; run.finished_at = now(); run.error = { type: "process_interrupted", message: "The runtime heartbeat stopped. In-flight work may have changed the environment without a recorded episode. Verify the workspace before continuing.", recoverable: true, environment_may_have_advanced: true };
      for (const thread of current.data.threads) if (thread.status === "running") thread.status = "failed";
      const pending = new Set(current.data.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
      for (const message of current.data.messages.slice()) for (const call of message.tool_calls ?? []) if (!pending.has(call.id)) current.data.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: run.error }) });
      event(current.data, sessionId, "run.finished", run.error.message, { run_id: run.run_id });
    }
  });
}
