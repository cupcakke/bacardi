import "dotenv/config";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import type { Episode, Session, WorkspaceSnapshot } from "../src/lib/nac/models";

const options = { session: { type: "string" }, new: { type: "boolean" }, model: { type: "string" }, "orchestrator-model": { type: "string" }, "max-parallel": { type: "string" }, "dry-run": { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" }, url: { type: "string" }, output: { type: "string", short: "o" } } as const;
const { values, positionals } = parseArgs({ options, allowPositionals: true });
const base = (values.url ?? process.env.NAC_URL ?? "http://localhost:3000").replace(/\/$/, "");
const headers: Record<string, string> = { "content-type": "application/json" };
if (process.env.NAC_HTTP_AUTH) headers.authorization = `Basic ${Buffer.from(process.env.NAC_HTTP_AUTH).toString("base64")}`;
async function request<T>(pathname: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${base}${pathname}`, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  if (!response.ok) { const text = await response.text(); throw new Error(`HTTP ${response.status}: ${text}`); }
  return await response.json() as T;
}
const snapshot = (): Promise<WorkspaceSnapshot> => request("/api/workspace");
function print(value: unknown): void { if (typeof value === "string" && !values.json) console.log(value); else console.log(JSON.stringify(value, null, 2)); }
function renderSession(session: Session): void {
  if (values.json) { print(session); return; }
  console.log(`\n${session.name}\n${session.id}\n${session.data.description}\n`);
  console.table(session.data.threads.map((thread) => ({ thread: thread.name, status: thread.status, episodes: thread.episodes.length, id: thread.thread_id })));
  console.table(session.data.runs.map((run) => ({ id: run.run_id, status: run.status, phase: run.phase, batches: run.batches.length, tokens: run.token_usage.total })));
}
function renderEpisode(episode: Episode): void {
  if (values.json) { print(episode); return; }
  console.log(`\nEpisode ${episode.sequence} · ${episode.status}\n${episode.episode_id}\n\n${episode.summary}\n`);
  console.table(episode.useful_files);
  console.table(episode.results);
  if (episode.open_questions.length) console.log(`Open questions\n${episode.open_questions.map((item) => `- ${item}`).join("\n")}`);
  if (episode.next_steps.length) console.log(`Next steps\n${episode.next_steps.map((item) => `- ${item}`).join("\n")}`);
  if (episode.error) print(episode.error);
}
async function selectedSession(): Promise<Session> {
  const state = await snapshot();
  const session = values.session ? state.sessions.find((item) => item.id === values.session) : state.sessions[0];
  if (!session) throw new Error("Session not found; use sessions create or --new");
  return session;
}
async function startRun(prompt: string, session: Session, wait: boolean): Promise<void> {
  if (!prompt.trim()) throw new Error("A nonempty prompt is required");
  const config: Record<string, unknown> = {};
  if (values.model) config.worker_model = values.model;
  if (values["orchestrator-model"]) config.orchestrator_model = values["orchestrator-model"];
  if (values["max-parallel"]) config.max_parallel = Number(values["max-parallel"]);
  if (Object.keys(config).length) await request("/api/workspace", { action: "update_session", session_id: session.id, config });
  const result = await request<{ run_id: string }>("/api/workspace", { action: "run", session_id: session.id, prompt, dry_run: values["dry-run"] ?? false });
  if (!wait) { print(result); return; }
  const cancel = (): void => { request("/api/workspace", { action: "cancel", session_id: session.id }).then(() => console.error("Cancellation queued; waiting for in-flight workers."), (error: unknown) => console.error(String(error))); };
  process.once("SIGINT", cancel);
  let lastEvent = "";
  try {
    while (true) {
      const current = (await snapshot()).sessions.find((item) => item.id === session.id);
      if (!current) throw new Error("Session disappeared");
      const run = current.data.runs.find((item) => item.run_id === result.run_id);
      if (!run) throw new Error("Run disappeared");
      if (!values.json) {
        const events = current.data.events.filter((event) => event.run_id === run.run_id);
        const start = lastEvent ? events.findIndex((event) => event.id === lastEvent) + 1 : 0;
        for (const event of events.slice(start)) console.error(`${event.created_at}  ${event.type}  ${event.message}`);
        lastEvent = events.at(-1)?.id ?? lastEvent;
      }
      if (run.status !== "running") {
        if (values.json) print(run);
        else { for (const batch of run.batches) console.table(batch.calls.map((call) => ({ call: call.call_id, thread: call.thread_name, status: call.status, tokens: call.token_usage.total, duration_ms: call.duration_ms, environment_may_have_advanced: call.error?.environment_may_have_advanced ?? false }))); if (run.final_answer) print(run.final_answer); if (run.error) print(run.error); }
        if (["failed", "cancelled"].includes(run.status)) process.exitCode = 1;
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    }
  } finally { process.removeListener("SIGINT", cancel); }
}
async function interactive(): Promise<void> {
  const session = await selectedSession();
  console.log(`Nested · ${session.name}\nSession: ${session.id}\nEnter a goal or /help. Runs execute on the server; steering never interrupts a worker.\n`);
  const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "nested › " });
  input.prompt();
  for await (const line of input) {
    const text = line.trim();
    try {
      if (text === "/quit") { input.close(); break; }
      if (text === "/help") print("/steer <instruction>\n/steer-thread <thread name> | <instruction>\n/threads\n/episodes <thread name>\n/cancel\n/status\n/quit");
      else if (text.startsWith("/steer-thread ")) { const [name, ...instruction] = text.slice(14).split("|"); if (!name || !instruction.length) throw new Error("Use /steer-thread <thread name> | <instruction>"); print(await request("/api/workspace", { action: "steer", session_id: session.id, thread_name: name.trim(), text: instruction.join("|").trim() })); }
      else if (text.startsWith("/steer ")) print(await request("/api/workspace", { action: "steer", session_id: session.id, text: text.slice(7) }));
      else if (text === "/cancel") print(await request("/api/workspace", { action: "cancel", session_id: session.id }));
      else if (["/status", "/threads"].includes(text)) { const current = (await snapshot()).sessions.find((item) => item.id === session.id); if (!current) throw new Error("Session not found"); renderSession(current); }
      else if (text.startsWith("/episodes ")) { const current = (await snapshot()).sessions.find((item) => item.id === session.id); const thread = current?.data.threads.find((item) => item.name === text.slice(10)); if (!thread) throw new Error("Thread not found"); thread.episodes.forEach(renderEpisode); }
      else if (text.startsWith("/")) throw new Error("Unknown command; use /help");
      else if (text) await startRun(text, session, false);
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    input.prompt();
  }
}
const help = `Nested Agent Coordinator\n\nUsage: npx tsx bin/nac.ts <command> [options]\n\nCommands:\n  run "<goal>" [--session ID | --new] [--dry-run]\n  continue "<goal>" --session ID\n  interactive [--session ID]\n  sessions create "<name>" | list | show | delete | export | import <file> | compact\n  threads list | show "<name>"\n  episodes list "<thread>" | show <episode_id>\n  config show | validate\n  doctor\n\nOptions:\n  --session ID              Select a persistent session\n  --new                     Create a new session\n  --model MODEL             Worker model\n  --orchestrator-model MODEL Planning model\n  --max-parallel N           Maximum concurrent workers\n  --dry-run                 Plan without dispatching workers\n  --json                    Machine-readable output\n  --output, -o PATH          Session export destination\n  --url URL                 Running Nested server (default localhost:3000)\n  --help, -h                Show this help\n\nNAC_URL sets the server URL. NAC_HTTP_AUTH supplies username:password for a protected server.\n`;
async function main(): Promise<void> {
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command, operation, ...rest] = positionals;
  if (command === "doctor") {
    const health = await request<{ ok: boolean }>("/api/health");
    const state = await snapshot();
    print({ server: base, health, providers: state.providers, sessions: state.sessions.length, workspace: state.workspace, credentials_configured: Object.values(state.providers).some(Boolean) });
    if (!Object.values(state.providers).some(Boolean)) process.exitCode = 1;
  } else if (["run", "continue"].includes(command)) {
    if (command === "continue" && !values.session) throw new Error("continue requires --session ID");
    const prompt = [operation, ...rest].filter(Boolean).join(" ");
    const session = values.new ? (await request<{ session: Session }>("/api/workspace", { action: "create_session", name: prompt.slice(0, 80) || "New session" })).session : await selectedSession();
    await startRun(prompt, session, true);
  } else if (command === "interactive") await interactive();
  else if (command === "sessions") {
    if (operation === "list") { const state = await snapshot(); if (values.json) print(state.sessions); else console.table(state.sessions.map((session) => ({ id: session.id, name: session.name, threads: session.data.threads.length, runs: session.data.runs.length, updated: session.updated_at }))); }
    else if (operation === "create") { const name = rest.join(" "); if (!name) throw new Error("sessions create requires a name"); print(await request("/api/workspace", { action: "create_session", name })); }
    else if (operation === "import") { if (!rest[0]) throw new Error("sessions import requires a JSON filename"); print(await request("/api/workspace", { action: "import_session", bundle: JSON.parse(await readFile(rest[0], "utf8")) })); }
    else {
      const session = await selectedSession();
      if (operation === "show") renderSession(session);
      else if (operation === "delete") print(await request("/api/workspace", { action: "delete_session", session_id: session.id }));
      else if (operation === "compact") print(await request("/api/workspace", { action: "compact", session_id: session.id }));
      else if (operation === "export") { const bundle = await request(`/api/workspace?export=${encodeURIComponent(session.id)}`); if (values.output) { await writeFile(values.output, JSON.stringify(bundle, null, 2), { encoding: "utf8", flag: "wx" }); console.error(`Exported ${values.output}`); } else print(bundle); }
      else throw new Error("Unknown sessions command; use --help");
    }
  } else if (command === "threads") {
    const session = await selectedSession();
    if (operation === "list") { if (values.json) print(session.data.threads); else console.table(session.data.threads.map((thread) => ({ name: thread.name, status: thread.status, episodes: thread.episodes.length, id: thread.thread_id }))); }
    else if (operation === "show") { const thread = session.data.threads.find((item) => item.name === rest.join(" ")); if (!thread) throw new Error("Thread not found"); print(thread); }
    else throw new Error("Unknown threads command; use --help");
  } else if (command === "episodes") {
    const session = await selectedSession();
    if (operation === "list") { const thread = session.data.threads.find((item) => item.name === rest.join(" ")); if (!thread) throw new Error("Thread not found"); if (values.json) print(thread.episodes); else thread.episodes.forEach(renderEpisode); }
    else if (operation === "show") { const episode = session.data.threads.flatMap((thread) => thread.episodes).find((item) => item.episode_id === rest[0]); if (!episode) throw new Error("Episode not found"); renderEpisode(episode); }
    else throw new Error("Unknown episodes command; use --help");
  } else if (command === "config") {
    const session = await selectedSession();
    if (operation === "show") print(session.data.config);
    else if (operation === "validate") { const { sessionConfigSchema } = await import("../src/lib/nac/models"); print({ valid: sessionConfigSchema.safeParse(session.data.config).success }); }
    else throw new Error("Unknown config command; use --help");
  } else throw new Error("Unknown command; use --help");
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
