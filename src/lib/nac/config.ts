import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "@iarna/toml";
import { sessionConfigSchema, type SessionConfig } from "./models";

export async function loadConfig(overrides: Partial<SessionConfig> = {}): Promise<SessionConfig> {
  let config: Record<string, unknown> = {};
  for (const file of [path.join(homedir(), ".config/nac/config.toml"), path.resolve(".nac/config.toml")]) {
    try { config = { ...config, ...parse(await readFile(file, "utf8")) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const numeric = new Set(["max_parallel", "max_turns", "max_tool_calls", "timeout_sec", "context_budget", "source_episode_limit", "temperature", "max_tokens"]);
  for (const key of Object.keys(sessionConfigSchema.shape)) {
    const value = process.env[`NAC_${key.toUpperCase()}`];
    if (value !== undefined) config[key] = numeric.has(key) ? Number(value) : value;
  }
  if (config.provider === "anthropic") {
    config.worker_model ??= "claude-sonnet-4-20250514";
    config.orchestrator_model ??= "claude-sonnet-4-20250514";
  }
  return sessionConfigSchema.parse({ ...config, ...overrides });
}
export function providerStatus(): { openai: boolean; anthropic: boolean } { return { openai: Boolean(process.env.OPENAI_API_KEY), anthropic: Boolean(process.env.ANTHROPIC_API_KEY) }; }
export function workspaceRoot(): string { return path.resolve(process.env.NAC_WORKSPACE ?? "/tmp/nac-workspaces"); }
export function redact(text: string): string {
  let result = text.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_\-]{12,}/g, "[REDACTED]");
  for (const key of [process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.DATABASE_URL, process.env.NAC_HTTP_AUTH]) if (key) result = result.split(key).join("[REDACTED]");
  return result;
}
