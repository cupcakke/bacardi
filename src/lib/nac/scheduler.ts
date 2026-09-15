import type { ThreadCall } from "./models";

export class ScheduleError extends Error {
  constructor(message: string, public readonly callIds: string[]) { super(message); this.name = "ScheduleError"; }
}
export function topologicalWaves(calls: ThreadCall[]): ThreadCall[][] {
  const ids = new Set<string>();
  for (const call of calls) { if (ids.has(call.call_id)) throw new ScheduleError(`Duplicate call id: ${call.call_id}`, [call.call_id]); ids.add(call.call_id); }
  for (const call of calls) for (const dependency of call.depends_on) if (!ids.has(dependency)) throw new ScheduleError(`Unknown dependency ${dependency} in ${call.call_id}`, [call.call_id, dependency]);
  const completed = new Set<string>();
  const waves: ThreadCall[][] = [];
  while (completed.size < calls.length) {
    const wave = calls.filter((call) => !completed.has(call.call_id) && call.depends_on.every((dependency) => completed.has(dependency)));
    if (!wave.length) { const blocked = calls.filter((call) => !completed.has(call.call_id)).map((call) => call.call_id); throw new ScheduleError(`Dependency cycle blocks calls: ${blocked.join(", ")}`, blocked); }
    const names = new Set<string>();
    const serialized: ThreadCall[] = [];
    for (const call of wave) if (!names.has(call.thread_name)) { names.add(call.thread_name); serialized.push(call); }
    waves.push(serialized);
    for (const call of serialized) completed.add(call.call_id);
  }
  return waves;
}
export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Parallelism must be a positive integer");
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await fn(items[index]); }
  }));
  return results;
}
