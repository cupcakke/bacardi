import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { buildContext, truncate, type SourceEpisode } from "./context";
import { redact } from "./config";
import { loadInstructions } from "./instructions";
import { addUsage, emptyUsage, episodeSubmissionSchema, jsonSchema, type Episode, type EpisodeError, type SessionConfig, type Thread, type Usage } from "./models";
import { HTTPProvider } from "./providers";
import { allowedTools, jailedPath, type ToolContext } from "./tools";
import { now } from "./store";

export type WorkerOutcome = Omit<Episode, "episode_id" | "sequence">;
export class WorkerFailure extends Error {
  constructor(public readonly detail: EpisodeError, public readonly usage: Usage, public readonly duration: number) { super(detail.message); this.name = "WorkerFailure"; }
}
export async function executeWorker(thread: Thread, action: string, sources: SourceEpisode[], config: SessionConfig, workspace: string, audit: (name: string, detail: Record<string, unknown>) => Promise<void>): Promise<WorkerOutcome> {
  const started = Date.now();
  let usage = emptyUsage();
  let mutated = false;
  const signal = AbortSignal.timeout(config.timeout_sec * 1000);
  const touched = new Set<string>();
  const outcomes: { key: string; value: string }[] = [];
  try {
    const root = await jailedPath(workspace, thread.tool_policy.working_dir);
    const instructions = await loadInstructions(root, workspace, action, thread.system_prompt);
    const context = buildContext(thread, action, sources, config, instructions);
    const messages = context.messages;
    const tools = allowedTools(thread.tool_policy);
    const definitions = [...tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })), { name: "submit_episode", description: "Submit the one terminal handoff episode for this bounded task. Runtime metadata is assigned by the store.", input_schema: jsonSchema(episodeSubmissionSchema) }];
    const provider = new HTTPProvider(config);
    const toolContext: ToolContext = { root, policy: thread.tool_policy, signal, touched };
    let calls = 0;
    let repaired = false;
    let finalText = "";
    const finish = async (submission: z.infer<typeof episodeSubmissionSchema>, error?: EpisodeError): Promise<WorkerOutcome> => {
      if (submission.status === "failed") throw new Error(`Worker reported failure: ${submission.summary}`);
      const usefulFiles = [];
      for (const file of submission.useful_files) {
        const resolved = await jailedPath(root, file.path);
        const info = await stat(resolved);
        if (!info.isFile()) throw new Error(`Useful path is not a file: ${file.path}`);
        const sha256 = info.size <= 16000000 ? createHash("sha256").update(await readFile(resolved)).digest("hex") : undefined;
        usefulFiles.push({ ...file, path: path.relative(workspace, resolved).replaceAll(path.sep, "/"), sha256 });
      }
      return { ...submission, useful_files: usefulFiles, thread_id: thread.thread_id, created_at: now(), requested_action: action, token_usage: usage, duration_ms: Date.now() - started, source_episode_refs: context.sourceIds, ...(error ? { error } : {}) };
    };
    for (let turn = 0; turn < config.max_turns + 1; turn++) {
      signal.throwIfAborted();
      const response = await provider.chat(messages, definitions, config.worker_model, signal);
      usage = addUsage(usage, response.usage);
      finalText = response.text || finalText;
      messages.push({ role: "assistant", content: response.text, ...(response.tool_calls.length ? { tool_calls: response.tool_calls } : {}) });
      if (!response.tool_calls.length) {
        if (!repaired) { repaired = true; messages.push({ role: "user", content: "VALIDATION ERROR: You ended without submit_episode. Call submit_episode now with a truthful schema-valid handoff. This is your only repair turn." }); continue; }
        break;
      }
      const submissionCalls = response.tool_calls.filter((call) => call.name === "submit_episode");
      if (submissionCalls.length && response.tool_calls.length !== 1) {
        for (const call of response.tool_calls) messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "submit_episode must be the only tool in the terminal response; none of this turn's tools were executed" }) });
        continue;
      }
      for (const call of response.tool_calls) {
        signal.throwIfAborted();
        if (call.name === "submit_episode") {
          try { return await finish(episodeSubmissionSchema.parse(call.arguments)); }
          catch (error) {
            if (repaired) throw error;
            repaired = true;
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: redact(error instanceof Error ? error.message : String(error)), instruction: "Repair your episode and call submit_episode once. This is your only repair turn." }) });
            continue;
          }
        }
        if (++calls > Math.min(config.max_tool_calls, thread.tool_policy.max_tool_calls)) throw new Error("Worker tool-call limit exceeded");
        const selected = tools.find((tool) => tool.name === call.name);
        if (!selected) { messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: `Tool ${call.name} is not granted by this thread's policy` }) }); continue; }
        if (selected.is_mutating) { mutated = true; await audit("tool.mutation_started", { tool: selected.name, environment_may_have_advanced: true }); }
        try {
          const result = await selected.execute(call.arguments, toolContext);
          const text = truncate(redact(JSON.stringify(result)), 24000);
          outcomes.push({ key: selected.name, value: truncate(text, 1000) });
          messages.push({ role: "tool", tool_call_id: call.id, content: text });
          await audit("tool.completed", { tool: selected.name, is_mutating: selected.is_mutating });
        } catch (error) {
          signal.throwIfAborted();
          const message = redact(error instanceof Error ? error.message : String(error));
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: message }) });
          await audit("tool.failed", { tool: selected.name, error: message, environment_may_have_advanced: mutated });
        }
      }
      if (turn === config.max_turns - 2) messages.push({ role: "user", content: "Turn budget is almost exhausted. Submit your best truthful complete or partial episode now." });
    }
    const files: { path: string; role: string }[] = [];
    for (const file of touched) { try { if ((await stat(await jailedPath(root, file))).isFile()) files.push({ path: file, role: "File modified during this worker run; inspect to verify the current state" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    if (!finalText && !outcomes.length) throw new Error("Worker ended without a final message or useful tool outcomes");
    return await finish({ summary: truncate(finalText || outcomes.map((outcome) => `${outcome.key}: ${outcome.value}`).join("\n"), 4000), useful_files: files.slice(0, 80), results: outcomes.slice(-80), open_questions: ["The worker did not submit a validated handoff; verify these transcript-derived results."], next_steps: ["Verify the actual workspace state before continuing."], status: "partial" }, { type: "episode_not_submitted", message: "No episode was submitted after the repair request; a partial handoff was extracted from actual transcript and tool outcomes.", recoverable: true, environment_may_have_advanced: mutated });
  } catch (error) {
    throw new WorkerFailure({ type: signal.aborted ? "worker_timeout" : "worker_failure", message: redact(error instanceof Error ? error.message : String(error)), recoverable: true, environment_may_have_advanced: mutated }, usage, Date.now() - started);
  }
}
