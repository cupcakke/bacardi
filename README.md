# Nested Agent Coordinator

A Next.js App Router application for hierarchical agent orchestration, with a persistent PostgreSQL workspace, real OpenAI and Anthropic HTTP providers, and a browser and CLI control surface.

## Install and start

Requires Node.js 20.9+, npm, and PostgreSQL. Use a persistent filesystem for worker artifacts.

1. Run `npm install`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` and at least one provider credential.
3. Run `npx drizzle-kit push` to install the PostgreSQL schema.
4. Run `npm run build`.
5. Run `npm run start`.
6. Open `http://localhost:3000`.

For development, use `npm run dev`. The first workspace request creates one real session with three configured, unexecuted workstreams: research, implementation, and review. No episodes, runs, or provider responses are fabricated.

Set `NAC_HTTP_AUTH` to a strong `username:password` value before exposing the service to a network. Authentication is optional for a private local deployment; without this variable the application is not access-restricted. Put the server behind HTTPS. The health endpoint remains unauthenticated for platform probes and does not expose session content.

## Provider credentials

OpenAI uses `OPENAI_API_KEY` and the Chat Completions endpoint at `OPENAI_BASE_URL`. Anthropic uses `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and the Messages API with version `2023-06-01`. Both have real HTTP implementations, tool serialization, usage accounting, SSE streaming support, and retry handling for transport errors, 408, 409, 429, and server errors. Credentials are read only on the server and redacted from runtime error output.

Choose a matching provider and model in Settings → Models & providers. For Anthropic, a suitable model is `claude-sonnet-4-20250514`. A model name must be available to the configured provider account. Model calls can incur provider charges, including planning-only runs. Missing credentials produce an explicit error before any run is reserved.

## Runtime semantics

The orchestrator can only use `list_threads`, `get_thread_episodes`, `get_episode`, `get_session_info`, and `dispatch_batch`. It never receives filesystem, shell, or network tools. Dispatch must be the only tool call in its turn, and each batch resolves completely before the next planning call.

Batches are validated DAGs. Dependencies reference intra-batch call ids. The executor respects declaration order, the configured concurrency bound, and serializes repeated calls to the same thread. Failed or skipped dependencies cascade into skipped downstream calls. Unknown source threads and episode ids fail only the affected call.

Each worker creates a new in-memory context and runs one bounded task. Context order is the durable charter plus protocol and instructions, the thread's own episodes in sequence, explicitly marked external episodes, and the requested action. External context never becomes the target thread's history. Oldest external episodes are removed first when the estimated context budget is exceeded; older own episodes are elided to summary and results next, then explicitly truncated. The system prompt and requested action are protected. Token budgeting uses a conservative UTF-8 byte estimate; provider-reported usage is retained independently.

`submit_episode` is the terminal tool. Episode fields are strictly validated, useful paths must actually exist, and SHA-256 is computed for bounded-size files. A missing submission receives one repair request. If final prose still replaces the handoff, the runtime derives a partial episode only from the actual final text, touched files, and successful tool outcomes. A failed worker never appends an episode. Mutation attempts are tracked conservatively, so a failure can explicitly warn that the environment advanced without durable thread history.

Orchestrator steering is queued FIFO and drained atomically immediately before the next planning call. Thread steering is appended to that thread's next requested action. Neither changes an in-flight worker. Cancellation stops launching additional calls; already-started workers finish subject to their own hard timeout.

## Persistence and deployment

All application database interactions use Drizzle ORM and the configured PostgreSQL client. A session is stored as a validated JSONB aggregate in `nac_sessions`. Every read-modify-write uses a PostgreSQL row lock and transaction, including episode sequence allocation. This prevents lost updates and allocates gap-free per-thread sequences. The aggregate contains threads, episodes, runs, batches, call reports, steering, messages, and timestamped correlation-aware events.

Export includes the complete session aggregate as a versioned JSON bundle. Import validates all fields, unique identities, sequence continuity, and source references. Import refuses to overwrite a session with the same id. Workspace files are not embedded in the bundle and must be restored separately. In-flight exported runs become explicit interrupted failures rather than silently replaying side effects. Compact preserves every episode and run record while dropping conversation preceding the retained run window.

Runs execute with Next.js `after` on the application's Node process. Deploy this application on a long-lived Node server, not a short-lived serverless function. A heartbeat identifies interrupted runs after two minutes, persists a failure, and requires on-disk verification before continuation. This implementation uses fresh worker contexts in one Node runtime, not one separate operating-system process per worker. PostgreSQL is the storage backend; JSON is a portable export format, not an alternative live backend.

Use persistent PostgreSQL backups and a persistent `NAC_WORKSPACE` volume. `/tmp/nac-workspaces` is convenient for local development but is not durable across container replacement. Workspace file mutations and PostgreSQL commits cannot be one distributed transaction; this is why environment-advanced warnings are part of the handoff protocol. Multiple running orchestrators cannot reserve the same session concurrently.

## Tool security

File tools resolve paths and symlinks against the session or thread working root. Mutating, shell, and network permissions are independent, defaulting to file mutation allowed, shell denied, and network denied. The orchestrator cannot escalate shell or network permissions when creating a thread. Only the operator can grant them through thread settings.

Shell execution requires the Linux `bwrap` executable and working unprivileged namespace support. It binds only the workspace as writable, mounts the required system executable/library directories read-only, creates private process, device, and temporary filesystems, clears the environment to an allowlist, disables network, checks destructive command patterns, enforces timeout, and caps collected output. If Bubblewrap cannot be executed, shell execution fails closed. Do not treat the command denylist by itself as an isolation boundary. Shell network access remains disabled even if the thread has permission to use the separate web-fetch tool.

Public web fetching resolves and pins public IPv4 addresses, rejects credentials and nonstandard ports, validates redirects, refuses private destinations and unsupported MIME types, limits responses to 1 MiB, and observes matching robots rules. Filesystem search skips symlinks, dependencies, version-control internals, and environment files. Search is bounded by file count, file size, line width, and match count.

This is an operator-controlled workspace. Do not point a session root at a directory writable by an untrusted concurrent process. Path checks are not a substitute for an operating-system security boundary against hostile local races.

## Project and skill instructions

The worker walks from its configured root toward its working directory, loading `AGENTS.md` and `.nac/instructions.md` in nearest-last order. `@include relative/path.md` expands local includes with canonical-path cycle detection, root containment, an eight-level depth limit, and size caps. Application host directories outside the session root are deliberately excluded.

Skills are discovered in `<session-root>/.nac/skills`, `~/.config/nac/skills`, and `NAC_SKILL_PATHS`. Each Markdown file, or a directory's `SKILL.md`, has YAML frontmatter containing `name`, `description`, `when_to_use`, optional `tools`, and `always_include`. Relevance is the count of distinct, lowercase alphanumeric keywords of at least three characters shared by the action/charter and skill metadata. Always-included skills sort first; other matches sort by descending score, then name. Selected bodies are injected under explicit skill headings within a 16,000-character cap. Skills cannot grant extra tools.

## CLI

The CLI talks to the running application so browser and terminal share the same durable state. Run `npx tsx bin/nac.ts --help` for commands and flags. Each subcommand accepts `--help`. `--json` emits structured results; failures produce a nonzero exit code. Set `NAC_URL` if the server is not at localhost:3000. When HTTP authentication is enabled, set matching `NAC_HTTP_AUTH` for the CLI.

Examples:

- Single-thread goal: `npx tsx bin/nac.ts run "Use the Implementation thread to create notes/goal.md with a concise project brief, read it back, and submit the verified handoff." --new`
- Parallel work with dependency: `npx tsx bin/nac.ts run "Dispatch Research and Implementation independently to inspect the workspace and inventory its files. Then dispatch Review with depends_on both call ids and both source threads to reconcile their findings into a verified handoff." --session SESSION_ID --max-parallel 4`
- Resume: `npx tsx bin/nac.ts continue "Continue from the retained episodes and verify the current files before making further changes." --session SESSION_ID`
- Interactive steering: `npx tsx bin/nac.ts interactive --session SESSION_ID`, enter a goal, then `/steer Prefer small, reviewable changes`. To target a workstream, use `/steer-thread Implementation | Verify existing files before editing.`
- Export: `npx tsx bin/nac.ts sessions export --session SESSION_ID --output session.json`
- Import: `npx tsx bin/nac.ts sessions import session.json`
- Plan only: `npx tsx bin/nac.ts run "Inspect and propose a bounded implementation plan" --session SESSION_ID --dry-run`

## Configuration precedence

CLI-provided settings update the selected session. Initial session configuration is loaded from explicit overrides, then `NAC_*` environment variables, then `./.nac/config.toml`, then `~/.config/nac/config.toml`, then validated built-in defaults. Once created, a session retains its own configuration; browser settings are durable per session. TOML keys match the lower-case names below.

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `OPENAI_API_KEY` | OpenAI-compatible credential | Unset |
| `OPENAI_BASE_URL` | OpenAI API root including `/v1` | `https://api.openai.com/v1` |
| `ANTHROPIC_API_KEY` | Anthropic credential | Unset |
| `ANTHROPIC_BASE_URL` | Anthropic API root including `/v1` | `https://api.anthropic.com/v1` |
| `NAC_PROVIDER` | `openai` or `anthropic` | `openai` |
| `NAC_WORKER_MODEL` | Worker model id | `gpt-4.1-mini` |
| `NAC_ORCHESTRATOR_MODEL` | Planning model id | `gpt-4.1-mini` |
| `NAC_MAX_PARALLEL` | Concurrent workers, 1–12 | 4 |
| `NAC_MAX_TURNS` | Worker turns, 1–100 | 24 |
| `NAC_MAX_TOOL_CALLS` | Worker tool calls, 1–200 | 40 |
| `NAC_TIMEOUT_SEC` | Worker/request timeout, 10–1800 seconds | 300 |
| `NAC_CONTEXT_BUDGET` | Estimated context tokens, 4000–200000 | 48000 |
| `NAC_SOURCE_EPISODE_LIMIT` | Latest source episodes per thread; zero means all | 0 |
| `NAC_TEMPERATURE` | Sampling temperature, 0–1 | 0.2 |
| `NAC_MAX_TOKENS` | Model output cap, 256–16384 | 4096 |
| `NAC_WORKSPACE` | Parent of session working roots | `/tmp/nac-workspaces` |
| `NAC_SKILL_PATHS` | Extra skill roots separated by platform path delimiter | Unset |
| `NAC_URL` | CLI/test server URL | `http://localhost:3000` |
| `NAC_HTTP_AUTH` | Optional HTTP Basic `username:password` | Unset |

## Validation and tests

Run these from the repository root:

- `npx next typegen`
- `npm exec tsc -- --noEmit --pretty false`
- `npm run lint`
- `npm run build`
- `node --import tsx --test tests/runtime.test.ts`
- `npx playwright install --with-deps chromium`
- `npx playwright test`

Runtime tests use real temporary files and real PostgreSQL transactions, with no model network access. They cover strict schemas, configuration bounds, unique ids, DAG cycles/order, concurrency limits, thread weaving and budgeting, file/symlink jails, exact edits, tool policy filtering, instruction/skill discovery, missing-credential refusal, concurrent persistence, failure/skip cascades, steering durability, and session import/export. They create and delete isolated test sessions.

Browser tests require the application to be running. They exercise real session and thread creation, durable thread steering, reload persistence, search, JSON export, and mobile navigation. Live provider end-to-end execution requires actual credentials and is not represented as a recorded-provider test. The codebase contains no simulated production provider.

## Source map

- `src/components/workspace.tsx`: responsive operator workspace and all interactive views.
- `src/app/api/workspace/route.ts`: validated session, thread, run, steering, and import/export API.
- `src/lib/nac/models.ts`: strict model/tool boundary schemas and runtime types.
- `src/lib/nac/providers.ts`: OpenAI and Anthropic HTTP/SSE contracts and retry logic.
- `src/lib/nac/runtime.ts`: planning/dispatch alternation, batch execution, steering, and interruption recovery.
- `src/lib/nac/worker.ts`: fresh-context tool loop, episode validation and repair, mutation tracking.
- `src/lib/nac/context.ts`: provenance labeling and context budgeting.
- `src/lib/nac/scheduler.ts`: deterministic DAG waves and bounded async execution.
- `src/lib/nac/tools.ts`: policy-filtered file, edit, search, shell, and public web tools.
- `src/lib/nac/instructions.ts`: project instructions and deterministic skill selection.
- `src/lib/nac/store.ts`: locked PostgreSQL session transactions and event records.
- `src/lib/nac/bundle.ts`, `src/lib/nac/import-session.ts`: portable-session validation and import.
- `src/lib/nac/config.ts`: layered configuration, workspace paths, and secret redaction.
- `src/lib/nac/prompts.ts`: complete orchestrator and worker protocol prompts.
- `src/db/schema.ts`: PostgreSQL schema.
- `src/proxy.ts`: optional HTTP Basic authentication.
- `bin/nac.ts`: server-connected CLI and interactive session.

Licensed under MIT.
