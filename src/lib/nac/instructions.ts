import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { parse } from "yaml";
import { z } from "zod";
import { truncate } from "./context";

const skillSchema = z.object({ name: z.string(), description: z.string(), when_to_use: z.union([z.string(), z.array(z.string())]), tools: z.array(z.string()).optional(), always_include: z.boolean().default(false) });
async function optionalRead(file: string): Promise<string | null> { try { return await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
async function loadWithIncludes(file: string, seen: Set<string>, root: string, depth = 0): Promise<string> {
  if (depth > 8) throw new Error("Instruction include depth exceeds 8");
  const content = await optionalRead(file);
  if (content === null) return "";
  const canonical = await realpath(file);
  if (seen.has(canonical)) return "";
  if (!canonical.startsWith(root + path.sep) && canonical !== root) throw new Error("Instruction include escapes its instruction root");
  seen.add(canonical);
  let result = truncate(content, 24000);
  for (const match of result.matchAll(/^@include\s+(.+)$/gm)) {
    const included = path.resolve(path.dirname(file), match[1].trim());
    result = result.replace(match[0], await loadWithIncludes(included, seen, root, depth + 1));
  }
  return result;
}
export async function loadInstructions(cwd: string, root: string, action: string, charter: string): Promise<string> {
  const directories: string[] = [];
  let current = cwd;
  while (current === root || current.startsWith(root + path.sep)) {
    directories.unshift(current);
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const project: string[] = [];
  const seen = new Set<string>();
  for (const directory of directories) for (const name of ["AGENTS.md", ".nac/instructions.md"]) {
    const content = await loadWithIncludes(path.join(directory, name), seen, root);
    if (content) project.push(`PROJECT INSTRUCTIONS: ${path.relative(root, path.join(directory, name))}\n${content}`);
  }
  const searchPaths = [path.join(root, ".nac/skills"), path.join(homedir(), ".config/nac/skills"), ...(process.env.NAC_SKILL_PATHS?.split(path.delimiter).filter(Boolean) ?? [])];
  const keywords = new Set(`${action} ${charter}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const skills: { name: string; body: string; score: number; always: boolean }[] = [];
  for (const directory of searchPaths) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100)) {
      if (entry.isSymbolicLink()) continue;
      const file = entry.isDirectory() ? path.join(directory, entry.name, "SKILL.md") : path.join(directory, entry.name);
      if (!file.endsWith(".md")) continue;
      const content = await optionalRead(file);
      if (!content) continue;
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
      if (!match) throw new Error(`Skill ${file} requires YAML frontmatter`);
      const metadata = skillSchema.parse(parse(match[1]));
      const words = new Set(`${metadata.name} ${metadata.description} ${Array.isArray(metadata.when_to_use) ? metadata.when_to_use.join(" ") : metadata.when_to_use}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
      const score = [...words].filter((word) => keywords.has(word)).length;
      if (score > 0 || metadata.always_include) skills.push({ name: metadata.name, body: match[2], score, always: metadata.always_include });
    }
  }
  skills.sort((a, b) => Number(b.always) - Number(a.always) || b.score - a.score || a.name.localeCompare(b.name));
  let remaining = 16000;
  const selected: string[] = [];
  for (const skill of skills) {
    if (remaining < 200) break;
    const body = truncate(skill.body, remaining);
    selected.push(`SKILL: ${skill.name}\n${body}`);
    remaining -= body.length;
  }
  return `${truncate(project.join("\n\n"), 48000)}\n\nSELECTED SKILLS\n${selected.join("\n\n")}`;
}
