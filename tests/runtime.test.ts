import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pool } from "../src/db";
import { loadConfig } from "../src/lib/nac/config";
import { validateBundle } from "../src/lib/nac/bundle";
import { buildContext, truncate } from "../src/lib/nac/context";
import { importSession } from "../src/lib/nac/import-session";
import { loadInstructions } from "../src/lib/nac/instructions";
import { batchSchema, callSchema, emptyUsage, episodeSchema, episodeSubmissionSchema, policySchema, sessionConfigSchema, type Episode } from "../src/lib/nac/models";
import { HTTPProvider } from "../src/lib/nac/providers";
import { executeBatch, queueSteering, reserveRun } from "../src/lib/nac/runtime";
import { mapConcurrent, ScheduleError, topologicalWaves } from "../src/lib/nac/scheduler";
import { createSession, createThread, deleteSession, getSession, id, mutateSession, now } from "../src/lib/nac/store";
import { allowedTools, jailedPath, workerTools, type ToolContext } from "../src/lib/nac/tools";

const submission = { summary: "The test workspace contains a verified note file.", useful_files: [{ path: "note.txt", role: "Stores the test's verified text" }], results: [{ key: "file", value: "note.txt" }], open_questions: [], next_steps: [], status: "complete" as const };
function episode(threadId: string, sequence: number, summary = submission.summary): Episode { return episodeSchema.parse({ ...submission, summary, episode_id: `ep_test_${threadId}_${sequence}`, thread_id: threadId, sequence, created_at: "2026-01-01T00:00:00.000Z", requested_action: "Write and verify note.txt", token_usage: emptyUsage(), duration_ms: 1, source_episode_refs: [] }); }
const config = sessionConfigSchema.parse({});
after(async () => { await pool.end(); });

test("strict model ingestion rejects unknown fields and oversized handoffs", () => {
  assert.throws(() => episodeSubmissionSchema.parse({ ...submission, sequence: 1 }));
  assert.throws(() => episodeSubmissionSchema.parse({ ...submission, summary: "x".repeat(4001) }));
  assert.throws(() => episodeSubmissionSchema.parse({ ...submission, useful_files: [{ path: "a", role: "b", unexpected: true }] }));
  const original = episode("t", 1);
  assert.deepEqual(episodeSchema.parse(JSON.parse(JSON.stringify(original))), original);
});
test("tool policies refuse unknown grants and validate hard limits", () => {
  assert.throws(() => policySchema.parse({ execute_everything: true }));
  assert.throws(() => policySchema.parse({ max_tool_calls: 0 }));
  assert.equal(policySchema.parse({}).allow_shell, false);
  assert.equal(policySchema.parse({}).allow_network, false);
});
test("configuration validates all numeric bounds and CLI overrides", async () => {
  const resolved = await loadConfig({ max_parallel: 2, max_turns: 5 });
  assert.equal(resolved.max_parallel, 2);
  assert.equal(resolved.max_turns, 5);
  await assert.rejects(loadConfig({ max_parallel: 13 }));
  await assert.rejects(loadConfig({ timeout_sec: -1 }));
});
test("identifiers are unique and UTC clocks round-trip", () => {
  const ids = Array.from({ length: 1000 }, () => id("test"));
  assert.equal(new Set(ids).size, 1000);
  assert.match(ids[0], /^test_[a-z0-9]+_[a-z0-9-]+$/);
  assert.equal(new Date(now()).toISOString().endsWith("Z"), true);
});
test("DAG scheduling respects dependencies and declaration order", () => {
  const calls = batchSchema.parse({ calls: [{ call_id: "a", thread_name: "A", requested_action: "First" }, { call_id: "b", thread_name: "B", requested_action: "Independent" }, { call_id: "c", thread_name: "C", requested_action: "After A", depends_on: ["a"] }, { call_id: "d", thread_name: "D", requested_action: "After both", depends_on: ["b", "c"] }] }).calls;
  assert.deepEqual(topologicalWaves(calls).map((wave) => wave.map((call) => call.call_id)), [["a", "b"], ["c"], ["d"]]);
});
test("DAG scheduling rejects cycles, duplicate ids, and unknown dependencies", () => {
  const a = callSchema.parse({ call_id: "a", thread_name: "A", requested_action: "A", depends_on: ["b"] });
  const b = callSchema.parse({ call_id: "b", thread_name: "B", requested_action: "B", depends_on: ["a"] });
  assert.throws(() => topologicalWaves([a, b]), ScheduleError);
  assert.throws(() => topologicalWaves([a, a]), /Duplicate/);
  assert.throws(() => topologicalWaves([a]), /Unknown dependency/);
});
test("the same workstream is never scheduled twice in one wave", () => {
  const calls = batchSchema.parse({ calls: [{ call_id: "a", thread_name: "Shared", requested_action: "First" }, { call_id: "b", thread_name: "Shared", requested_action: "Second" }, { call_id: "c", thread_name: "Other", requested_action: "Independent" }] }).calls;
  assert.deepEqual(topologicalWaves(calls).map((wave) => wave.map((call) => call.call_id)), [["a", "c"], ["b"]]);
});
test("concurrency is bounded and outputs retain declaration order", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => { active++; peak = Math.max(peak, active); await new Promise<void>((resolve) => setTimeout(resolve, 5)); active--; return value * 2; });
  assert.equal(peak, 2);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
  await assert.rejects(mapConcurrent([1], 0, async (value) => value));
});
test("thread weaving orders own history, external episodes, and requested action", () => {
  const thread = createThread("Weaving test", "Verify context provenance.");
  thread.episodes.push(episode(thread.thread_id, 1), episode(thread.thread_id, 2));
  const source = episode("other", 1);
  const built = buildContext(thread, "Third bounded action", [{ thread_name: "Other", episode: source }], config, "PROJECT INSTRUCTIONS\nFollow local conventions.");
  assert.equal(built.messages[0].role, "system");
  assert.match(built.messages[1].content, /THIS THREAD'S OWN HISTORY — episode 1/);
  assert.match(built.messages[2].content, /THIS THREAD'S OWN HISTORY — episode 2/);
  assert.match(built.messages[3].content, /EXTERNAL CONTEXT FROM THREAD <Other>/);
  assert.equal(built.messages.at(-1)?.content, "Third bounded action");
  assert.deepEqual(built.sourceIds, [source.episode_id]);
  assert.equal(thread.episodes.length, 2);
  assert.equal(thread.episodes.some((item) => item.episode_id === source.episode_id), false);
});
test("context budgets drop oldest external episodes without changing history", () => {
  const thread = createThread("Budget test", "Read and verify files.");
  thread.episodes.push(episode(thread.thread_id, 1));
  const sources = Array.from({ length: 10 }, (_, index) => ({ thread_name: "Source", episode: episode("source", index + 1, "x".repeat(3900)) }));
  const built = buildContext(thread, "Protected requested action", sources, { ...config, context_budget: 5000, max_tokens: 512 }, "");
  assert.ok(built.sourceIds.length < sources.length);
  assert.equal(built.sourceIds.at(-1), sources.at(-1)?.episode.episode_id);
  assert.equal(built.messages.at(-1)?.content, "Protected requested action");
  assert.equal(thread.episodes.length, 1);
});
test("truncation has an explicit marker and a hard character cap", () => {
  const result = truncate("x".repeat(1000), 80);
  assert.ok(result.length <= 80);
  assert.match(result, /\[truncated \d+ chars\]/);
  assert.equal(truncate("short", 20), "short");
});
test("filesystem tools enforce symlink and relative path jails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nac-jail-"));
  const outside = await mkdtemp(path.join(tmpdir(), "nac-outside-"));
  try {
    await writeFile(path.join(outside, "private.txt"), "outside");
    await symlink(outside, path.join(root, "escape"));
    await assert.rejects(jailedPath(root, "../escape"), /escapes/);
    await assert.rejects(jailedPath(root, "escape/private.txt"), /Symlink escapes/);
    await assert.rejects(jailedPath(root, "escape/new.txt", true), /Symlink escapes/);
    assert.equal(await jailedPath(root, "nested/new.txt", true), path.join(root, "nested/new.txt"));
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test("real filesystem tools write, read, and verify exact edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nac-fs-"));
  const context: ToolContext = { root, policy: policySchema.parse({}), signal: AbortSignal.timeout(5000), touched: new Set() };
  const execute = async (name: string, input: Record<string, unknown>): Promise<unknown> => { const selected = workerTools.find((entry) => entry.name === name); assert.ok(selected); return selected.execute(input, context); };
  try {
    await execute("create_file", { path: "note.txt", content: "hello\nworld\n" });
    await assert.rejects(execute("create_file", { path: "note.txt", content: "overwrite" }));
    const edited = await execute("edit_file", { path: "note.txt", old_text: "world", new_text: "agents" }) as { diff: string };
    assert.match(edited.diff, /--- a\/note.txt/);
    assert.match(edited.diff, /\+agents/);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "hello\nagents\n");
    await assert.rejects(execute("edit_file", { path: "note.txt", old_text: "missing", new_text: "no" }), /not found/);
    await execute("write_file", { path: "repeated.txt", content: "same same" });
    await assert.rejects(execute("edit_file", { path: "repeated.txt", old_text: "same", new_text: "one" }), /occurrences/);
    await execute("edit_file", { path: "repeated.txt", old_text: "same", new_text: "two", occurrence: 1 });
    assert.equal(await readFile(path.join(root, "repeated.txt"), "utf8"), "same two");
    assert.ok(context.touched.has("note.txt"));
    const found = await execute("glob", { pattern: "**/*.txt" }) as string[];
    assert.ok(found.includes("note.txt"));
    const matches = await execute("search", { pattern: "agents" }) as { path: string }[];
    assert.equal(matches[0].path, "note.txt");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("policy filtering removes forbidden mutations, shell, and network tools", () => {
  const readonly = allowedTools(policySchema.parse({ allow_mutating: false }));
  assert.ok(readonly.every((entry) => !entry.is_mutating));
  assert.equal(readonly.some((entry) => entry.name === "shell"), false);
  assert.equal(readonly.some((entry) => entry.name === "web_fetch"), false);
  const permitted = allowedTools(policySchema.parse({ allow: ["read_file", "write_file"], deny: ["write_file"] }));
  assert.deepEqual(permitted.map((entry) => entry.name), ["read_file"]);
});
test("project instructions have nearest-last precedence and cycle-safe includes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nac-instructions-"));
  try {
    await mkdir(path.join(root, "child"));
    await writeFile(path.join(root, "AGENTS.md"), "Root rule.\n@include extra.md");
    await writeFile(path.join(root, "extra.md"), "Included rule.\n@include AGENTS.md");
    await writeFile(path.join(root, "child", "AGENTS.md"), "Nearest rule.");
    const result = await loadInstructions(path.join(root, "child"), root, "Inspect project", "Reviewer");
    assert.ok(result.indexOf("Root rule.") < result.indexOf("Nearest rule."));
    assert.equal(result.match(/Root rule\./g)?.length, 1);
    assert.match(result, /Included rule/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("skill relevance selects keyword matches and always-include instructions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nac-skills-"));
  try {
    const directory = path.join(root, ".nac", "skills");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "database.md"), "---\nname: Database\ndescription: SQL database indexing\nwhen_to_use: database migration\n---\nInspect migration constraints.");
    await writeFile(path.join(directory, "always.md"), "---\nname: Safety\ndescription: Safety rules\nwhen_to_use: every dispatch\nalways_include: true\n---\nVerify actual state.");
    await writeFile(path.join(directory, "unrelated.md"), "---\nname: Illustration\ndescription: Watercolor drawing\nwhen_to_use: watercolor\n---\nUse pigment.");
    const result = await loadInstructions(root, root, "Review database migration", "Engineer");
    assert.match(result, /Inspect migration constraints/);
    assert.match(result, /Verify actual state/);
    assert.doesNotMatch(result, /Use pigment/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("missing credentials fail before any provider network call", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try { await assert.rejects(new HTTPProvider({ ...config, provider: "openai" }).chat([{ role: "user", content: "Validate credentials" }], [], config.worker_model, AbortSignal.timeout(1000)), /Configure OPENAI_API_KEY/); }
  finally { if (saved !== undefined) process.env.OPENAI_API_KEY = saved; }
});
test("PostgreSQL mutations serialize concurrent writers without lost updates", async () => {
  const session = await createSession("Atomicity integration test", "0", {}, false);
  try {
    await Promise.all(Array.from({ length: 12 }, () => mutateSession(session.id, (current) => { current.data.description = String(Number(current.data.description) + 1); })));
    assert.equal((await getSession(session.id)).data.description, "12");
  } finally { await deleteSession(session.id); }
});
test("batch validation failures cascade skips and persist without episodes", async () => {
  const session = await createSession("DAG failure integration test", "", {}, false);
  try {
    const runId = await reserveRun(session.id, "Validate dependency propagation");
    const plan = batchSchema.parse({ calls: [
      { call_id: "a", thread_name: "A", thread_system_prompt: "Inspect sources", requested_action: "Inspect missing source", source_threads: ["does-not-exist"] },
      { call_id: "b", thread_name: "B", requested_action: "After A", depends_on: ["a"] },
      { call_id: "c", thread_name: "C", requested_action: "After B", depends_on: ["b"] },
    ] });
    const report = await executeBatch(session.id, runId, plan);
    assert.deepEqual(report.calls.map((call) => call.status), ["failed", "skipped", "skipped"]);
    assert.deepEqual(report.counts, { complete: 0, partial: 0, failed: 1, skipped: 2 });
    assert.equal(report.token_usage.total, 0);
    const stored = await getSession(session.id);
    assert.equal(stored.data.threads.flatMap((thread) => thread.episodes).length, 0);
    assert.equal(stored.data.runs[0].batches[0].calls.length, 3);
    assert.ok(stored.data.events.some((entry) => entry.type === "call.failed"));
  } finally { await mutateSession(session.id, (current) => { for (const run of current.data.runs) run.status = "cancelled"; }); await deleteSession(session.id); }
});
test("steering is durable FIFO and active sessions cannot be deleted", async () => {
  const session = await createSession("Steering integration test");
  try {
    await reserveRun(session.id, "Queue control instructions");
    await queueSteering(session.id, "First instruction");
    await queueSteering(session.id, "Second instruction");
    await queueSteering(session.id, "Next dispatch only", session.data.threads[0].name);
    const stored = await getSession(session.id);
    assert.deepEqual(stored.data.steering.map((item) => item.text), ["First instruction", "Second instruction", "Next dispatch only"]);
    assert.ok(stored.data.steering.every((item) => item.consumed_at === undefined));
    await assert.rejects(deleteSession(session.id), /active run/);
  } finally { await mutateSession(session.id, (current) => { for (const run of current.data.runs) run.status = "cancelled"; }); await deleteSession(session.id); }
});
test("portable exports re-import without losing episodes or overwriting sessions", async () => {
  const session = await createSession("Portable session integration test");
  try {
    await mutateSession(session.id, (current) => { const thread = current.data.threads[0]; thread.episodes.push(episode(thread.thread_id, 1)); });
    const stored = await getSession(session.id);
    const bundle = { format: "nested-session", version: 1, exported_at: now(), session: stored };
    assert.deepEqual(validateBundle(JSON.parse(JSON.stringify(bundle))).data.threads[0].episodes, stored.data.threads[0].episodes);
    await assert.rejects(importSession(bundle), /already exists/);
    await deleteSession(session.id);
    const imported = await importSession(bundle);
    assert.equal(imported.id, session.id);
    assert.equal((await getSession(session.id)).data.threads[0].episodes[0].sequence, 1);
    const invalid = structuredClone(bundle);
    invalid.session.data.threads[0].episodes[0].sequence = 2;
    assert.throws(() => validateBundle(invalid), /gap-free/);
  } finally { await deleteSession(session.id); }
});
