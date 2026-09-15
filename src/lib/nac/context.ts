import { tokenCount } from "./providers";
import { WORKER_PROMPT } from "./prompts";
import type { Episode, Message, SessionConfig, Thread } from "./models";

export type SourceEpisode = { thread_name: string; episode: Episode };
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = Math.max(0, max - 24);
  for (let pass = 0; pass < 4; pass++) kept = Math.max(0, max - ` [truncated ${text.length - kept} chars]`.length);
  const marker = ` [truncated ${text.length - kept} chars]`;
  return text.slice(0, kept) + marker;
}
export function buildContext(thread: Thread, action: string, sources: SourceEpisode[], config: SessionConfig, instructions: string): { messages: Message[]; sourceIds: string[] } {
  const system = `${thread.system_prompt}\n\n${WORKER_PROMPT}\n\nWORKSTREAM: ${thread.name}\nLIMITS: ${config.max_turns} turns, ${Math.min(config.max_tool_calls, thread.tool_policy.max_tool_calls)} tool calls, ${config.timeout_sec} seconds. Tool outputs capped at 24000 characters.\n\n${instructions}`;
  const own = thread.episodes.slice().sort((a, b) => a.sequence - b.sequence).map((episode) => ({ episode, text: JSON.stringify(episode) }));
  const external = sources.map((source) => ({ ...source, text: JSON.stringify(source.episode) }));
  const make = (): Message[] => [{ role: "system", content: system }, ...own.map((entry): Message => ({ role: "user", content: `THIS THREAD'S OWN HISTORY — episode ${entry.episode.sequence}\n${entry.text}` })), ...external.map((entry): Message => ({ role: "user", content: `EXTERNAL CONTEXT FROM THREAD <${entry.thread_name}> — read-only\n${entry.text}` })), { role: "user", content: action }];
  const cost = (): number => make().reduce((total, message) => total + tokenCount(message.content) + 8, 0);
  const budget = config.context_budget - config.max_tokens;
  while (cost() > budget && external.length) external.shift();
  for (const item of own) { if (cost() <= budget) break; item.text = JSON.stringify({ episode_id: item.episode.episode_id, sequence: item.episode.sequence, summary: item.episode.summary, results: item.episode.results, context_note: "Older episode elided to summary and results" }); }
  for (const item of own) { if (cost() <= budget) break; const excess = (cost() - budget) * 3; item.text = truncate(item.text, Math.max(80, item.text.length - excess)); }
  if (cost() > budget) throw new Error("Context budget is too small for the protected system prompt, requested action, and retained history. Increase the context budget.");
  return { messages: make(), sourceIds: external.map((source) => source.episode.episode_id) };
}
