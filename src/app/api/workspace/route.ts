import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { providerStatus, redact, workspaceRoot } from "@/lib/nac/config";
import { importSession } from "@/lib/nac/import-session";
import { policySchema, sessionConfigSchema } from "@/lib/nac/models";
import { createSession, createThread, deleteSession, ensureWorkspace, event, getSession, listSessions, mutateSession, now } from "@/lib/nac/store";
import { queueSteering, recoverInterruptedRuns, reserveRun, runOrchestrator } from "@/lib/nac/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("import_session"), bundle: z.unknown() }).strict(),
  z.object({ action: z.literal("create_session"), name: z.string().trim().min(1).max(100), description: z.string().max(24000).default(""), config: sessionConfigSchema.partial().optional(), starter_threads: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal("update_session"), session_id: z.string(), name: z.string().trim().min(1).max(100).optional(), description: z.string().max(24000).optional(), config: sessionConfigSchema.partial().optional() }).strict(),
  z.object({ action: z.literal("delete_session"), session_id: z.string() }).strict(),
  z.object({ action: z.literal("create_thread"), session_id: z.string(), name: z.string().trim().min(1).max(80), system_prompt: z.string().trim().min(1).max(16000), tags: z.array(z.string().max(40)).max(12).default([]), tool_policy: policySchema.optional() }).strict(),
  z.object({ action: z.literal("update_thread"), session_id: z.string(), thread_id: z.string(), system_prompt: z.string().min(1).max(16000), tool_policy: policySchema }).strict(),
  z.object({ action: z.literal("delete_thread"), session_id: z.string(), thread_id: z.string() }).strict(),
  z.object({ action: z.literal("run"), session_id: z.string(), prompt: z.string().trim().min(1).max(24000), dry_run: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal("steer"), session_id: z.string(), text: z.string().trim().min(1).max(12000), thread_name: z.string().optional() }).strict(),
  z.object({ action: z.literal("cancel"), session_id: z.string() }).strict(),
  z.object({ action: z.literal("compact"), session_id: z.string(), keep_runs: z.number().int().min(1).max(100).default(10) }).strict(),
]);
function errorResponse(error: unknown): NextResponse { return NextResponse.json({ error: redact(error instanceof Error ? error.message : String(error)) }, { status: error instanceof z.ZodError ? 400 : error instanceof Error && error.message.includes("not found") ? 404 : 409 }); }
function validateOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== request.headers.get("host") && new URL(origin).host !== request.headers.get("x-forwarded-host")) throw new Error("Cross-origin mutations are not allowed");
}
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const exportId = request.nextUrl.searchParams.get("export");
    if (exportId) {
      const session = await getSession(exportId);
      return new NextResponse(JSON.stringify({ format: "nested-session", version: 1, exported_at: now(), session }, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="nested-${session.id}.json"` } });
    }
    await ensureWorkspace();
    const records = await listSessions();
    for (const session of records) if (session.data.runs.some((run) => run.status === "running")) await recoverInterruptedRuns(session.id);
    return NextResponse.json({ sessions: await listSessions(), providers: providerStatus(), workspace: workspaceRoot() }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    validateOrigin(request);
    const text = await request.text();
    if (Buffer.byteLength(text) > 16777216) throw new Error("Request exceeds 16 MiB");
    const input = actionSchema.parse(JSON.parse(text));
    if (input.action === "import_session") return NextResponse.json({ session: await importSession(input.bundle) });
    if (input.action === "create_session") return NextResponse.json({ session: await createSession(input.name, input.description, input.config, input.starter_threads) });
    if (input.action === "delete_session") { await deleteSession(input.session_id); return NextResponse.json({ ok: true }); }
    if (input.action === "run") {
      const session = await getSession(input.session_id);
      if (!providerStatus()[session.data.config.provider]) throw new Error(`Set ${session.data.config.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} in the server environment to connect your model provider. No model call has been made.`);
      const runId = await reserveRun(input.session_id, input.prompt);
      after(async () => { await runOrchestrator(input.session_id, runId, input.dry_run); });
      return NextResponse.json({ run_id: runId }, { status: 202 });
    }
    if (input.action === "steer") { await queueSteering(input.session_id, input.text, input.thread_name); return NextResponse.json({ ok: true }); }
    await mutateSession(input.session_id, (session) => {
      const active = session.data.runs.find((run) => run.status === "running");
      if (input.action === "cancel") {
        if (!active) throw new Error("No active run to cancel");
        active.cancel_requested = true;
        event(session.data, session.id, "run.cancellation_requested", "Cancellation requested. In-flight workers will finish; new calls will not start.", { run_id: active.run_id });
      } else if (input.action === "update_session") {
        if (input.config && active) throw new Error("Configuration cannot change during an active run");
        if (input.name !== undefined) session.name = input.name;
        if (input.description !== undefined) session.data.description = input.description;
        if (input.config) session.data.config = sessionConfigSchema.parse({ ...session.data.config, ...input.config });
        event(session.data, session.id, "session.updated", "Session settings updated");
      } else if (input.action === "create_thread") {
        if (active) throw new Error("Wait for the active run to finish before adding a thread");
        if (session.data.threads.some((thread) => thread.name === input.name)) throw new Error("A thread with this name already exists");
        const thread = createThread(input.name, input.system_prompt, input.tags);
        if (input.tool_policy) thread.tool_policy = input.tool_policy;
        session.data.threads.push(thread);
        event(session.data, session.id, "thread.created", `${thread.name} workstream created`, { thread_id: thread.thread_id });
      } else if (input.action === "update_thread") {
        if (active) throw new Error("Wait for the active run to finish before changing tool permissions");
        const thread = session.data.threads.find((item) => item.thread_id === input.thread_id);
        if (!thread) throw new Error("Thread not found");
        thread.system_prompt = input.system_prompt;
        thread.tool_policy = input.tool_policy;
        thread.updated_at = now();
        event(session.data, session.id, "thread.updated", `${thread.name} charter and tool policy updated`, { thread_id: thread.thread_id });
      } else if (input.action === "delete_thread") {
        if (active) throw new Error("Cannot delete a thread during an active run");
        const thread = session.data.threads.find((item) => item.thread_id === input.thread_id);
        if (!thread) throw new Error("Thread not found");
        if (thread.episodes.length) throw new Error("Threads with retained episodes cannot be deleted. Export or delete the entire session instead.");
        session.data.threads = session.data.threads.filter((item) => item.thread_id !== input.thread_id);
        event(session.data, session.id, "thread.deleted", `${thread.name} workstream deleted`);
      } else if (input.action === "compact") {
        if (active) throw new Error("Cannot compact an active session");
        const prompts = new Set(session.data.runs.slice(-input.keep_runs).map((run) => run.prompt));
        const index = session.data.messages.findIndex((message, position) => position > 0 && message.role === "user" && prompts.has(message.content));
        if (index > 1) session.data.messages = [session.data.messages[0], { role: "user", content: "Earlier conversation was compacted. All thread episodes remain available through introspection tools. Retrieve them before relying on prior work." }, ...session.data.messages.slice(index)];
        event(session.data, session.id, "session.compacted", "Conversation compacted; all episodes and run records preserved");
      }
    });
    return NextResponse.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
