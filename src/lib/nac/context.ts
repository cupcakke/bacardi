import { tokenCount } from "./providers";
import { WORKER_PROMPT } from "./prompts";
import type { Episode, Message, SessionConfig, Thread } from "./models";

export type SourceEpisode = { thread_name: string; episode: Episode };

export const TOOL_OUTPUT_CHAR_LIMIT = 24000;

const MESSAGE_TOKEN_OVERHEAD = 8;
const ELISION_NOTE = "Episode elided to summary and results to fit the context budget";
const PROTECTED_BUDGET_ERROR = "Context budget is too small for the protected system prompt and requested action. Increase the context budget or reduce max_tokens.";
const RETAINED_BUDGET_ERROR = "Context budget is too small for the protected system prompt, requested action, and minimally retained history. Increase the context budget or reduce max_tokens.";

type OwnSlot = {
  episode: Episode;
  episodeId: string;
  sequence: number;
  originalIndex: number;
  text: string;
  tokens: number;
};

type ExternalSlot = {
  episodeId: string;
  threadName: string;
  text: string;
  tokens: number;
};

type Measurement = { text: string; tokens: number };

function requireObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function requireNonNegativeFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function singleLine(value: string): string {
  return value.replace(/[<>\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function safeCutIndex(text: string, index: number): number {
  const cut = Math.max(0, Math.min(text.length, Math.floor(index)));
  if (cut > 0 && cut < text.length) {
    const previous = text.charCodeAt(cut - 1);
    const next = text.charCodeAt(cut);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      return cut - 1;
    }
  }
  return cut;
}

function truncationMarker(removed: number): string {
  return ` [truncated ${removed} chars]`;
}

export function truncate(text: string, max: number): string {
  requireString(text, "text");
  if (typeof max !== "number" || Number.isNaN(max)) {
    throw new RangeError("max must be a number other than NaN.");
  }
  if (text.length <= max) {
    return text;
  }
  const limit = Math.max(0, Math.floor(max));
  if (limit === 0) {
    return "";
  }
  if (truncationMarker(text.length).length > limit) {
    return `${text.slice(0, safeCutIndex(text, limit - 1))}…`;
  }
  let low = 0;
  let high = Math.min(text.length, limit);
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const kept = safeCutIndex(text, middle);
    if (kept + truncationMarker(text.length - kept).length <= limit) {
      best = kept;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return text.slice(0, best) + truncationMarker(text.length - best);
}

function stringifyContext(value: unknown): string {
  const ancestors: object[] = [];
  try {
    const result = JSON.stringify(value, function (this: unknown, _key: string, current: unknown): unknown {
      if (typeof current === "bigint") {
        return current.toString();
      }
      if (typeof current !== "object" || current === null) {
        return current;
      }
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop();
      }
      if (ancestors.includes(current)) {
        return "[Circular]";
      }
      ancestors.push(current);
      return current;
    });
    return result === undefined ? "null" : result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to serialize context: ${reason}`);
  }
}

function checkedSum(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("Context token cost exceeds the safe integer range.");
  }
  return result;
}

function messageTokens(content: string): number {
  const counted = tokenCount(content);
  if (typeof counted !== "number" || !Number.isSafeInteger(counted) || counted < 0) {
    throw new Error("tokenCount must return a non-negative safe integer.");
  }
  return checkedSum(counted, MESSAGE_TOKEN_OVERHEAD);
}

function ownContent(sequence: number, text: string): string {
  return `THIS THREAD'S OWN HISTORY — episode ${sequence}\n${text}`;
}

function externalContent(threadName: string, text: string): string {
  return `EXTERNAL CONTEXT FROM THREAD <${threadName}> — read-only\n${text}`;
}

function ownMeasurement(sequence: number, text: string): Measurement {
  return { text, tokens: messageTokens(ownContent(sequence, text)) };
}

function excerptSource(episode: Episode, fallback: string): string {
  if (episode.summary === undefined && episode.results === undefined) {
    return fallback;
  }
  return stringifyContext({ summary: episode.summary, results: episode.results });
}

function compressedMeasurement(slot: OwnSlot, source: string, cap: number): Measurement {
  const excerpt = truncate(source, cap);
  const compact = excerpt.length === 0
    ? { episode_id: slot.episodeId, sequence: slot.sequence, truncated: true }
    : { episode_id: slot.episodeId, sequence: slot.sequence, truncated: true, excerpt };
  return ownMeasurement(slot.sequence, stringifyContext(compact));
}

function fitOwnSlot(slot: OwnSlot, currentTotal: number, budget: number): number {
  const otherTokens = currentTotal - slot.tokens;
  const source = excerptSource(slot.episode, slot.text);
  const minimum = compressedMeasurement(slot, source, 0);
  if (minimum.tokens >= slot.tokens) {
    return currentTotal;
  }
  if (minimum.tokens > budget - otherTokens) {
    slot.text = minimum.text;
    slot.tokens = minimum.tokens;
    return checkedSum(otherTokens, slot.tokens);
  }
  let low = 0;
  let high = source.length;
  let best = minimum;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = compressedMeasurement(slot, source, middle);
    if (candidate.tokens <= budget - otherTokens) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  slot.text = best.text;
  slot.tokens = best.tokens;
  return checkedSum(otherTokens, slot.tokens);
}

export function buildContext(
  thread: Thread,
  action: string,
  sources: SourceEpisode[],
  config: SessionConfig,
  instructions: string,
): { messages: Message[]; sourceIds: string[] } {
  requireObject(thread, "thread");
  requireObject(config, "config");
  requireObject(thread.tool_policy, "thread.tool_policy");
  if (!Array.isArray(thread.episodes)) {
    throw new TypeError("thread.episodes must be an array.");
  }
  if (!Array.isArray(sources)) {
    throw new TypeError("sources must be an array.");
  }

  const systemPrompt = requireString(thread.system_prompt, "thread.system_prompt");
  const workerPrompt = requireString(WORKER_PROMPT, "WORKER_PROMPT");
  const threadName = singleLine(requireString(thread.name, "thread.name"));
  const requestedAction = requireString(action, "action");
  const extraInstructions = requireString(instructions, "instructions");
  const maxTurns = requireNonNegativeInteger(config.max_turns, "config.max_turns");
  const configToolCalls = requireNonNegativeInteger(config.max_tool_calls, "config.max_tool_calls");
  const threadToolCalls = requireNonNegativeInteger(thread.tool_policy.max_tool_calls, "thread.tool_policy.max_tool_calls");
  const timeoutSeconds = requireNonNegativeFiniteNumber(config.timeout_sec, "config.timeout_sec");
  const contextBudget = requireNonNegativeInteger(config.context_budget, "config.context_budget");
  const maxTokens = requireNonNegativeInteger(config.max_tokens, "config.max_tokens");
  const budget = contextBudget - maxTokens;
  const limits = `WORKSTREAM: ${threadName}\nLIMITS: ${maxTurns} turns, ${Math.min(configToolCalls, threadToolCalls)} tool calls, ${timeoutSeconds} seconds. Tool outputs capped at ${TOOL_OUTPUT_CHAR_LIMIT} characters.`;
  const system = [systemPrompt, workerPrompt, limits, extraInstructions].filter((part) => part.trim().length > 0).join("\n\n");
  let total = checkedSum(messageTokens(system), messageTokens(requestedAction));
  if (total > budget) {
    throw new Error(PROTECTED_BUDGET_ERROR);
  }

  const own: OwnSlot[] = Array.from(thread.episodes, (episode, originalIndex) => {
    requireObject(episode, `thread.episodes[${originalIndex}]`);
    const episodeId = requireString(episode.episode_id, `thread.episodes[${originalIndex}].episode_id`);
    const sequence = requireNonNegativeInteger(episode.sequence, `thread.episodes[${originalIndex}].sequence`);
    const text = stringifyContext(episode);
    return { episode, episodeId, sequence, originalIndex, text, tokens: messageTokens(ownContent(sequence, text)) };
  }).sort((a, b) => a.sequence - b.sequence || a.originalIndex - b.originalIndex);

  for (const slot of own) {
    total = checkedSum(total, slot.tokens);
  }
  for (const slot of own) {
    if (total <= budget) {
      break;
    }
    const summary = stringifyContext({
      episode_id: slot.episodeId,
      sequence: slot.sequence,
      context_note: ELISION_NOTE,
      summary: slot.episode.summary,
      results: slot.episode.results,
    });
    const measurement = ownMeasurement(slot.sequence, summary);
    if (measurement.tokens < slot.tokens) {
      total -= slot.tokens - measurement.tokens;
      slot.text = measurement.text;
      slot.tokens = measurement.tokens;
    }
  }
  for (const slot of own) {
    if (total <= budget) {
      break;
    }
    total = fitOwnSlot(slot, total, budget);
  }
  if (total > budget) {
    throw new Error(RETAINED_BUDGET_ERROR);
  }

  const candidates: ExternalSlot[] = Array.from(sources, (source, index) => {
    requireObject(source, `sources[${index}]`);
    requireObject(source.episode, `sources[${index}].episode`);
    const threadName = singleLine(requireString(source.thread_name, `sources[${index}].thread_name`));
    const episodeId = requireString(source.episode.episode_id, `sources[${index}].episode.episode_id`);
    const text = stringifyContext(source.episode);
    return { episodeId, threadName, text, tokens: messageTokens(externalContent(threadName, text)) };
  });
  const external: ExternalSlot[] = [];
  for (const candidate of candidates.slice().reverse()) {
    if (candidate.tokens <= budget - total) {
      external.push(candidate);
      total += candidate.tokens;
    }
  }
  external.reverse();

  const messages: Message[] = [
    { role: "system", content: system },
    ...own.map((slot): Message => ({ role: "user", content: ownContent(slot.sequence, slot.text) })),
    ...external.map((slot): Message => ({ role: "user", content: externalContent(slot.threadName, slot.text) })),
    { role: "user", content: requestedAction },
  ];
  return { messages, sourceIds: external.map((slot) => slot.episodeId) };
}
