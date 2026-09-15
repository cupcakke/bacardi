import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { validateBundle } from "./bundle";
import { event, now } from "./store";
import type { Session } from "./models";

export async function importSession(bundle: unknown): Promise<Session> {
  const session = validateBundle(bundle);
  for (const run of session.data.runs) if (run.status === "running") {
    run.status = "failed";
    run.phase = "finished";
    run.finished_at = now();
    run.error = { type: "imported_incomplete_run", message: "The exported run was in flight. It has not been resumed automatically. Verify the actual workspace before starting a continuation.", recoverable: true, environment_may_have_advanced: true };
  }
  for (const thread of session.data.threads) if (thread.status === "running") thread.status = "failed";
  const completed = new Set(session.data.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
  for (const message of session.data.messages.slice()) for (const call of message.tool_calls ?? []) if (!completed.has(call.id)) session.data.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: { type: "imported_incomplete_call", message: "This tool call was in flight at export time and has not been replayed.", recoverable: true, environment_may_have_advanced: true } }) });
  event(session.data, session.id, "session.imported", "Portable session imported. Workspace files are not part of the bundle; verify or restore them before continuing.");
  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, session.id));
    if (existing.length) throw new Error("A session with this id already exists. Import never overwrites retained history.");
    await tx.insert(sessions).values({ id: session.id, name: session.name, data: session.data, createdAt: new Date(session.created_at), updatedAt: new Date() });
  });
  return session;
}
