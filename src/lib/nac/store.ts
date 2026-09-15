import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { loadConfig, redact } from "./config";
import { policySchema, type RuntimeEvent, type Session, type SessionConfig, type SessionData, type Thread } from "./models";

export const id = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 12)}`;
export const now = (): string => new Date().toISOString();
export function event(data: SessionData, sessionId: string, type: string, message: string, refs: Partial<RuntimeEvent> = {}): void {
  const item: RuntimeEvent = { id: id("evt"), type, message: redact(message), created_at: now(), session_id: sessionId, ...refs };
  data.events.push(item);
  console.info(redact(JSON.stringify(item)));
}
function hydrate(row: typeof sessions.$inferSelect): Session { return { id: row.id, name: row.name, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(), data: row.data }; }
export async function listSessions(): Promise<Session[]> { return (await db.select().from(sessions).orderBy(desc(sessions.updatedAt))).map(hydrate); }
export async function getSession(sessionId: string): Promise<Session> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!row) throw new Error("Session not found");
  return hydrate(row);
}
export async function mutateSession<T>(sessionId: string, fn: (session: Session) => T | Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update");
    if (!row) throw new Error("Session not found");
    const session = hydrate(row);
    const result = await fn(session);
    await tx.update(sessions).set({ name: session.name, data: session.data, updatedAt: new Date() }).where(eq(sessions.id, sessionId));
    return result;
  });
}
export function createThread(name: string, prompt: string, tags: string[] = []): Thread {
  return { thread_id: id("thr"), name, system_prompt: prompt, created_at: now(), updated_at: now(), status: "ready", tags, tool_policy: policySchema.parse({}), episodes: [] };
}
export async function createSession(name: string, description = "", config: Partial<SessionConfig> = {}, starterThreads = true): Promise<Session> {
  const sessionId = id("ses");
  const data: SessionData = { threads: [], runs: [], steering: [], messages: [], events: [], config: await loadConfig(config), description };
  if (starterThreads) data.threads = [
    createThread("Research & discovery", "Investigate requirements and the current project. Verify facts, identify constraints, and produce actionable findings. Do not modify application code unless explicitly asked.", ["Research"]),
    createThread("Implementation", "Implement focused, maintainable changes that satisfy the requested acceptance criteria. Verify the existing environment, follow project instructions, and report the exact files changed.", ["Engineering"]),
    createThread("Review & validation", "Independently review changes, test acceptance criteria, and identify defects or regressions. Report verified evidence and concrete follow-up actions.", ["Quality"]),
  ];
  event(data, sessionId, "session.created", "Session created. Your workspace is ready.");
  for (const thread of data.threads) event(data, sessionId, "thread.created", `${thread.name} workstream created`, { thread_id: thread.thread_id });
  const [row] = await db.insert(sessions).values({ id: sessionId, name, data }).returning();
  return hydrate(row);
}
export async function ensureWorkspace(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(72419731)`);
    const existing = await tx.select({ id: sessions.id }).from(sessions).limit(1);
    if (existing.length) return;
    const sessionId = id("ses");
    const threads = [
      createThread("Research & discovery", "Investigate requirements, inspect the project, and hand off verified findings and recommendations. Keep each task bounded.", ["Research"]),
      createThread("Implementation", "Build focused, maintainable changes against explicit acceptance criteria. Follow project instructions and verify your work.", ["Engineering"]),
      createThread("Review & validation", "Independently validate changes, inspect code, and report concrete evidence, defects, and next steps.", ["Quality"]),
    ];
    const data: SessionData = { threads, runs: [], steering: [], messages: [], events: [], config: await loadConfig(), description: "A fresh workspace for your next big idea. Give the orchestrator a goal, and let your threads take it from there." };
    event(data, sessionId, "session.created", "Your first session is ready");
    for (const thread of threads) event(data, sessionId, "thread.created", `${thread.name} is ready for its first task`, { thread_id: thread.thread_id });
    await tx.insert(sessions).values({ id: sessionId, name: "My first session", data });
  });
}
export async function deleteSession(sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update");
    if (!row) throw new Error("Session not found");
    if (row.data.runs.some((run) => run.status === "running")) throw new Error("Cancel the active run before deleting this session");
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
  });
}
