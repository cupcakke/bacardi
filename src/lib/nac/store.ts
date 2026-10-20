import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { loadConfig, redact } from "./config";
import { policySchema, type RuntimeEvent, type Session, type SessionConfig, type SessionData, type Thread } from "./models";

type ProtectedEventField = "id" | "type" | "message" | "created_at" | "session_id";
export type EventRefs = Partial<Omit<RuntimeEvent, ProtectedEventField>>;
type SessionRow = typeof sessions.$inferSelect;

const MAX_EVENTS_PER_SESSION = 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const pendingEvents = new WeakMap<SessionData, RuntimeEvent[]>();
const heldSessionLocks = new AsyncLocalStorage<ReadonlySet<string>>();

export const id = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
export const now = (): string => new Date().toISOString();

export function event(data: SessionData, sessionId: string, type: string, message: string, refs: EventRefs = {}): RuntimeEvent {
  const item = {
    ...refs,
    id: id("evt"),
    type: type as RuntimeEvent["type"],
    message: redact(message),
    created_at: now(),
    session_id: sessionId,
  } as RuntimeEvent;
  data.events.push(item);
  const queue = pendingEvents.get(data);
  if (queue) queue.push(item);
  else pendingEvents.set(data, [item]);
  return item;
}

export function flushEvents(data: SessionData): void {
  const queue = pendingEvents.get(data);
  if (!queue) return;
  pendingEvents.delete(data);
  for (const item of queue) console.info(redact(JSON.stringify(item)));
}

export function discardEvents(data: SessionData): void {
  pendingEvents.delete(data);
}

function trimEvents(data: SessionData): void {
  if (data.events.length > MAX_EVENTS_PER_SESSION) data.events.splice(0, data.events.length - MAX_EVENTS_PER_SESSION);
}

function toIso(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function hydrate(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    created_at: toIso(row.createdAt as Date | string | null | undefined),
    updated_at: toIso(row.updatedAt as Date | string | null | undefined),
    data: row.data as SessionData,
  };
}

function assertNotHeld(sessionId: string): void {
  const held = heldSessionLocks.getStore();
  if (held && held.has(sessionId)) throw new Error("Nested access to a session that is already locked by the current operation is not allowed");
}

function withHeld<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const held = new Set(heldSessionLocks.getStore() ?? []);
  held.add(sessionId);
  return heldSessionLocks.run(held, fn);
}

export interface ListSessionsOptions {
  limit?: number;
  offset?: number;
}

export async function listSessions(options: ListSessionsOptions = {}): Promise<Session[]> {
  const requested = Number.isFinite(options.limit) ? Math.floor(options.limit as number) : DEFAULT_PAGE_SIZE;
  const limit = Math.min(Math.max(requested, 1), MAX_PAGE_SIZE);
  const offset = Number.isFinite(options.offset) ? Math.max(Math.floor(options.offset as number), 0) : 0;
  const rows = await db.select().from(sessions).orderBy(desc(sessions.updatedAt)).limit(limit).offset(offset);
  return rows.map(hydrate);
}

export async function getSession(sessionId: string): Promise<Session> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!row) throw new Error("Session not found");
  return hydrate(row);
}

export async function mutateSession<T>(sessionId: string, fn: (session: Session) => T | Promise<T>): Promise<T> {
  assertNotHeld(sessionId);
  let committedData: SessionData | undefined;
  try {
    const result = await withHeld(sessionId, () =>
      db.transaction(async (tx) => {
        const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update");
        if (!row) throw new Error("Session not found");
        const session = hydrate(row);
        committedData = session.data;
        const value = await fn(session);
        trimEvents(session.data);
        const updatedAt = new Date();
        session.updated_at = updatedAt.toISOString();
        await tx.update(sessions).set({ name: session.name, data: session.data, updatedAt }).where(eq(sessions.id, sessionId));
        return value;
      }),
    );
    if (committedData) flushEvents(committedData);
    return result;
  } catch (error) {
    if (committedData) discardEvents(committedData);
    throw error;
  }
}

export function createThread(name: string, prompt: string, tags: string[] = []): Thread {
  const timestamp = now();
  return { thread_id: id("thr"), name, system_prompt: prompt, created_at: timestamp, updated_at: timestamp, status: "ready", tags, tool_policy: policySchema.parse({}), episodes: [] };
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
  for (const thread of data.threads) event(data, sessionId, "thread.created", `${thread.name} workstream created`, { thread_id: thread.thread_id } as EventRefs);
  try {
    const timestamp = new Date();
    const [row] = await db.insert(sessions).values({ id: sessionId, name, data, createdAt: timestamp, updatedAt: timestamp }).returning();
    if (!row) throw new Error("Failed to create session");
    flushEvents(data);
    return hydrate(row);
  } catch (error) {
    discardEvents(data);
    throw error;
  }
}

export async function ensureWorkspace(): Promise<void> {
  const config = await loadConfig({});
  let createdData: SessionData | undefined;
  try {
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
      const data: SessionData = { threads, runs: [], steering: [], messages: [], events: [], config, description: "A fresh workspace for your next big idea. Give the orchestrator a goal, and let your threads take it from there." };
      createdData = data;
      event(data, sessionId, "session.created", "Your first session is ready");
      for (const thread of threads) event(data, sessionId, "thread.created", `${thread.name} is ready for its first task`, { thread_id: thread.thread_id } as EventRefs);
      const timestamp = new Date();
      await tx.insert(sessions).values({ id: sessionId, name: "My first session", data, createdAt: timestamp, updatedAt: timestamp });
    });
    if (createdData) flushEvents(createdData);
  } catch (error) {
    if (createdData) discardEvents(createdData);
    throw error;
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  assertNotHeld(sessionId);
  await withHeld(sessionId, () =>
    db.transaction(async (tx) => {
      const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update");
      if (!row) throw new Error("Session not found");
      const data = row.data as SessionData;
      if (data.runs.some((run) => String(run.status) === "running")) throw new Error("Cancel the active run before deleting this session");
      await tx.delete(sessions).where(eq(sessions.id, sessionId));
    }),
  );
}
