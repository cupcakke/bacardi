import { readFile, writeFile, readdir, stat, lstat, realpath, mkdir, rm, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve4 } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { z } from "zod";
import { jsonSchema, type ToolPolicy } from "./models";
import { truncate } from "./context";
import type { ToolDefinition } from "./providers";

export type ToolContext = { root: string; policy: ToolPolicy; signal: AbortSignal; touched: Set<string> };
export type Tool = ToolDefinition & { is_mutating: boolean; network?: boolean; shell?: boolean; execute: (input: Record<string, unknown>, context: ToolContext) => Promise<unknown> };
export async function jailedPath(root: string, input: string, allowMissing = false): Promise<string> {
  const canonicalRoot = await realpath(root);
  const target = path.resolve(canonicalRoot, input);
  if (target !== canonicalRoot && !target.startsWith(canonicalRoot + path.sep)) throw new Error("Path escapes the working-directory jail");
  let candidate = target;
  while (true) {
    try {
      const canonical = await realpath(candidate);
      if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + path.sep)) throw new Error("Symlink escapes the working-directory jail");
      return target;
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT" || candidate === canonicalRoot) throw error;
      candidate = path.dirname(candidate);
    }
  }
}
const pathInput = z.object({ path: z.string().min(1).max(1024) }).strict();
function tool<T extends z.ZodType<Record<string, unknown>>>(name: string, description: string, schema: T, mutating: boolean, execute: (input: z.infer<T>, context: ToolContext) => Promise<unknown>, flags: { network?: boolean; shell?: boolean } = {}): Tool {
  return { name, description, input_schema: jsonSchema(schema), is_mutating: mutating, ...flags, execute: (input, context) => execute(schema.parse(input), context) };
}
const ignored = new Set(["node_modules", ".git", ".next", ".env", "vendor"]);
async function walk(root: string, dir: string, output: string[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (output.length >= 5000) return;
    if (ignored.has(item.name) || item.name.startsWith(".env.") || item.isSymbolicLink()) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await walk(root, file, output, signal);
    else if (item.isFile()) output.push(path.relative(root, file));
  }
}
function isPrivate(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets.length !== 4 || octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || (octets[0] === 198 && [18, 19].includes(octets[1]));
}
async function publicRequest(url: URL, signal: AbortSignal, redirects = 0): Promise<{ status: number; text: string; contentType: string }> {
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("Only public HTTP(S) URLs on standard ports are allowed");
  const addresses = await resolve4(url.hostname);
  if (!addresses.length || addresses.some(isPrivate)) throw new Error("Private or reserved network addresses are not allowed");
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { signal, headers: { "user-agent": "NestedAgentCoordinator/1.0", accept: "text/plain,text/html,application/json" }, lookup: (_hostname, options, callback) => { if (options.all) callback(null, addresses.map((address) => ({ address, family: 4 }))); else callback(null, addresses[0], 4); } }, (response) => {
      const status = response.statusCode ?? 500;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 4) { reject(new Error("HTTP redirect limit exceeded")); return; }
        publicRequest(new URL(response.headers.location, url), signal, redirects + 1).then(resolve, reject);
        return;
      }
      const contentType = response.headers["content-type"] ?? "";
      if (!/^(text\/|application\/(json|xml|xhtml\+xml))/.test(contentType) && status !== 404) { response.destroy(); reject(new Error(`Unsupported content type: ${contentType}`)); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1048576) { response.destroy(new Error("HTTP body exceeds 1 MiB")); } else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf8"), contentType }));
    });
    request.setTimeout(20000, () => request.destroy(new Error("HTTP request timed out")));
    request.on("error", reject);
    request.end();
  });
}
async function shell(command: string, cwd: string, signal: AbortSignal, timeout: number): Promise<unknown> {
  const deny = [/\brm\s+(-[^\s]*[rf][^\s]*\s+)*\//i, /\b(mkfs|shutdown|reboot|mount|umount|sudo|su|dd)\b/i, /:\(\)\s*\{/];
  if (deny.some((pattern) => pattern.test(command))) throw new Error("Command refused by destructive-command policy");
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin"];
  for (const dir of ["/lib", "/lib64"]) { try { await stat(dir); args.push("--ro-bind", dir, dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", cwd, "/workspace", "--chdir", "/workspace", "--", "/bin/sh", "-c", command);
  return new Promise((resolve, reject) => {
    const child = spawn("bwrap", args, { cwd, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", TERM: "dumb", NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"], signal });
    let output = "";
    let bytes = 0;
    let timedOut = false;
    const collect = (chunk: Buffer): void => { bytes += chunk.length; if (output.length < 24000) output += chunk.toString("utf8").slice(0, 24000 - output.length); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout * 1000);
    child.on("error", (error) => { clearTimeout(timer); reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "Bubblewrap is not installed; shell execution is refused rather than run without isolation" : error.message)); });
    child.on("close", (code) => { clearTimeout(timer); if (timedOut) reject(new Error(`Shell timeout after ${timeout} seconds; environment may have advanced`)); else resolve({ exit_code: code, output: output + (bytes > 24000 ? `\n[truncated ${bytes - 24000} bytes]` : "") }); });
  });
}
export const workerTools: Tool[] = [
  tool("read_file", "Read a UTF-8 file with line numbers and bounded output.", pathInput.extend({ offset: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(2000).default(200) }), false, async (input, context) => {
    const file = await jailedPath(context.root, input.path);
    if ((await stat(file)).size > 4 * 1024 * 1024) throw new Error("File exceeds the 4 MiB read limit");
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");
    return { path: input.path, total_lines: lines.length, content: truncate(lines.slice(input.offset - 1, input.offset - 1 + input.limit).map((line, index) => `${input.offset + index}: ${line}`).join("\n"), 24000), sha256: createHash("sha256").update(content).digest("hex") };
  }),
  tool("list_dir", "List entries in a jailed directory.", pathInput, false, async (input, context) => (await readdir(await jailedPath(context.root, input.path), { withFileTypes: true })).slice(0, 1000).map((item) => ({ name: item.name, type: item.isSymbolicLink() ? "symlink" : item.isDirectory() ? "directory" : "file" }))),
  tool("stat", "Get metadata for a file or directory.", pathInput, false, async (input, context) => { const info = await stat(await jailedPath(context.root, input.path)); return { path: input.path, size: info.size, modified_at: info.mtime.toISOString(), is_directory: info.isDirectory() }; }),
  tool("glob", "Find files by a glob. Supports *, **, and ?. Ignores dependencies, version control, and environment files.", z.object({ pattern: z.string().min(1).max(500) }).strict(), false, async (input, context) => {
    const files: string[] = [];
    await walk(context.root, context.root, files, context.signal);
    const expression = input.pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0001\//g, "(?:.*/)?").replace(/\u0001/g, ".*");
    return files.filter((file) => new RegExp(`^${expression}$`).test(file));
  }),
  tool("search", "Search text files with a bounded regular expression; return matching paths and line numbers.", z.object({ pattern: z.string().min(1).max(250), case_sensitive: z.boolean().default(true) }).strict(), false, async (input, context) => {
    if (/(\([^)]*[+*][^)]*\))[+*{]|\\[1-9]/.test(input.pattern)) throw new Error("Nested quantifiers and backreferences are not allowed");
    const regex = new RegExp(input.pattern, input.case_sensitive ? "" : "i");
    const files: string[] = [];
    await walk(context.root, context.root, files, context.signal);
    const matches: { path: string; line: number; text: string }[] = [];
    for (const file of files) {
      context.signal.throwIfAborted();
      const full = await jailedPath(context.root, file);
      if ((await stat(full)).size > 1000000) continue;
      const content = await readFile(full, "utf8");
      if (content.includes("\0")) continue;
      const lines = content.split("\n");
      for (let index = 0; index < lines.length && matches.length < 100; index++) if (regex.test(lines[index].slice(0, 4000))) matches.push({ path: file, line: index + 1, text: truncate(lines[index], 500) });
      if (matches.length >= 100) break;
    }
    return matches;
  }),
  ...(["write_file", "create_file"] as const).map((name) => tool(name, name === "create_file" ? "Create a new UTF-8 file; refuse overwriting existing files." : "Write the complete content of a UTF-8 file.", pathInput.extend({ content: z.string().max(200000) }), true, async (input, context) => {
    const file = await jailedPath(context.root, input.path, true);
    await mkdir(path.dirname(file), { recursive: true });
    await jailedPath(context.root, input.path, true);
    await writeFile(file, input.content, { encoding: "utf8", flag: name === "create_file" ? "wx" : "w" });
    context.touched.add(path.relative(context.root, file));
    return { path: path.relative(context.root, file), bytes: Buffer.byteLength(input.content), sha256: createHash("sha256").update(input.content).digest("hex") };
  })),
  tool("delete_path", "Delete a file or empty directory inside the working root. Nonempty directories are refused.", pathInput, true, async (input, context) => { const file = await jailedPath(context.root, input.path); if (file === context.root) throw new Error("Cannot delete workspace root"); if ((await lstat(file)).isDirectory()) throw new Error("Directory deletion is refused; delete individual files explicitly"); await rm(file); return { deleted: input.path }; }),
  tool("move_path", "Move a file without replacing an existing destination.", z.object({ source: z.string().min(1), destination: z.string().min(1) }).strict(), true, async (input, context) => {
    const source = await jailedPath(context.root, input.source);
    const destination = await jailedPath(context.root, input.destination, true);
    if (source === context.root) throw new Error("Cannot move workspace root");
    try { await lstat(destination); throw new Error("Destination already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
    context.touched.add(path.relative(context.root, destination));
    return { source: input.source, destination: input.destination };
  }),
  tool("edit_file", "Apply an exact-string edit. The target must be unique unless an occurrence index is provided. Returns a unified diff.", pathInput.extend({ old_text: z.string().min(1).max(100000), new_text: z.string().max(100000), occurrence: z.number().int().nonnegative().optional() }), true, async (input, context) => {
    const file = await jailedPath(context.root, input.path);
    if ((await stat(file)).size > 2000000) throw new Error("File exceeds edit size limit");
    const original = await readFile(file, "utf8");
    const positions: number[] = [];
    let position = original.indexOf(input.old_text);
    while (position !== -1) { positions.push(position); position = original.indexOf(input.old_text, position + input.old_text.length); }
    if (!positions.length) throw new Error("Exact target text not found; no edit applied");
    if (input.occurrence === undefined && positions.length !== 1) throw new Error(`Target has ${positions.length} occurrences; supply a zero-based occurrence index`);
    const selected = positions[input.occurrence ?? 0];
    if (selected === undefined) throw new Error("Occurrence index out of range");
    const updated = original.slice(0, selected) + input.new_text + original.slice(selected + input.old_text.length);
    await writeFile(file, updated, "utf8");
    context.touched.add(path.relative(context.root, file));
    const before = original.split("\n");
    const after = updated.split("\n");
    return { path: input.path, diff: truncate(`--- a/${input.path}\n+++ b/${input.path}\n@@ -1,${before.length} +1,${after.length} @@\n${before.map((line) => `-${line}`).join("\n")}\n${after.map((line) => `+${line}`).join("\n")}`, 24000), sha256: createHash("sha256").update(updated).digest("hex") };
  }),
  tool("shell", "Execute a shell command in a Bubblewrap filesystem and network sandbox. Refuses execution if isolation is unavailable.", z.object({ command: z.string().min(1).max(8000), timeout_sec: z.number().int().min(1).max(120).default(30) }).strict(), true, async (input, context) => shell(input.command, context.root, context.signal, input.timeout_sec), { shell: true }),
  tool("web_fetch", "Fetch a public text URL, respecting applicable robots.txt disallow rules. Private networks and oversized bodies are refused.", z.object({ url: z.string().url().max(2000) }).strict(), false, async (input, context) => {
    const url = new URL(input.url);
    const robots = await publicRequest(new URL("/robots.txt", url), context.signal);
    if (robots.status >= 500 || [401, 403].includes(robots.status)) throw new Error("robots.txt is unavailable or access is denied");
    if (robots.status === 200) {
      let applies = false;
      let lastWasAgent = false;
      const rules: { allow: boolean; path: string }[] = [];
      for (const line of robots.text.split("\n")) {
        const clean = line.split("#")[0].trim();
        const colon = clean.indexOf(":");
        if (colon < 0) continue;
        const key = clean.slice(0, colon).toLowerCase();
        const value = clean.slice(colon + 1).trim();
        if (key === "user-agent") { if (!lastWasAgent) applies = false; applies ||= value === "*" || /nestedagentcoordinator/i.test(value); lastWasAgent = true; }
        else { lastWasAgent = false; if (applies && ["allow", "disallow"].includes(key) && value) rules.push({ allow: key === "allow", path: value }); }
      }
      const matching = rules.filter((rule) => { const expression = rule.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"); return new RegExp(`^${expression}`).test(url.pathname + url.search); }).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
      if (matching[0] && !matching[0].allow) throw new Error("robots.txt disallows this URL");
    }
    const response = await publicRequest(url, context.signal);
    return { url: url.toString(), status: response.status, content_type: response.contentType, content: truncate(response.text, 24000) };
  }, { network: true }),
];
export function allowedTools(policy: ToolPolicy): Tool[] {
  return workerTools.filter((entry) => (!policy.allow.length || policy.allow.includes(entry.name)) && !policy.deny.includes(entry.name) && (!entry.is_mutating || policy.allow_mutating) && (!entry.shell || policy.allow_shell) && (!entry.network || policy.allow_network));
}
