# Nova — Personal AI Assistant

Nova is a personal AI assistant and autonomous agent system for Robert Matthews. Features a polished dark-theme chat UI (BOB), multiple LLM model selection via Bitdeer API, deep-worker background reasoning, workspace management, voice input/output, and autonomous heartbeat loops.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port auto-assigned)
- `pnpm --filter @workspace/nova run dev` — run the Nova chat UI (served at `/`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Chat UI: voice.html + bob.js (compiled bundle, served via Vite as static)
- AI: Bitdeer API (OpenAI-compatible), supports Mistral, Kimi, DeepSeek, Qwen, MiniMax, Gemini, GPT-OSS

## Where things live

- `artifacts/nova/index.html` — Nova chat UI (voice.html, self-contained)
- `artifacts/nova/public/assets/bob.js` — Compiled JS bundle for the chat UI
- `artifacts/api-server/src/` — Express API server
- `lib/api-spec/openapi.yaml` — API contract source of truth
- `lib/db/src/schema/` — Database schema (Drizzle ORM)
- `scripts/` — Nova CLI, ledger, deep-worker, poll-events daemons
- `tools/anti-hallucinate/` — Deterministic fact-verification CLI
- `SOUL.md` — Agent runtime contract (26 rules)
- `AGENTS.md` — Operator-grade response rules
- `DIRECTIVE.md` — Full system directive
- `IDENTITY.md` — Nova identity
- `USER.md` — Operator identity (Robert Matthews)
- `HEARTBEAT.md` — Autonomous heartbeat mission
- `TOOLS.md` — Live tool inventory
- `TASKS.md` — Agent task backlog
- `GOVERNANCE.json` — Autonomy governance (kill switch, daily run cap)
- `openclaw.example.json` — OpenClaw gateway config template

## Architecture decisions

- Nova chat UI is served as a static HTML+JS bundle via Vite — no React compilation needed for the UI itself
- Direct API mode: browser calls Bitdeer API directly with user's API key (set in Settings modal)
- Proxy mode: Vite dev server proxies `/api-proxy` → `https://api-inference.bitdeer.ai` to avoid CORS issues; set Base URL to `/api-proxy/v1` in Settings
- Gateway (WebSocket) mode: routes through OpenClaw gateway — requires OpenClaw deployed separately
- Deep worker: background reasoning daemon (`scripts/deep-worker.mjs`) dispatches hard tasks to a separate model (Kimi-K2.6 by default)

## Product

- **Nova Chat**: Full-featured AI chat UI with model selection, streaming responses, markdown rendering, code highlighting, chat history
- **Workspace system**: Organizes files into Medical, Health, Dietary, Fitness, Todo, Tasks, Agents, Pictures — Medical is password-protected
- **Voice I/O**: Microphone input and TTS output
- **Deep Worker**: Submit hard problems as background jobs, retrieve results asynchronously
- **Autonomous heartbeat**: Cron-driven self-management loop that polls tasks, patches bugs, reports status
- **Anti-hallucination**: Deterministic verifier gates every factual claim before it's sent

## API Keys (set in Settings modal)

- **Bitdeer API Key** (`sk-...`): for all LLM inference. Base URL: `https://api-inference.bitdeer.ai/v1` (or `/api-proxy/v1` for Replit proxy)
- **Gateway Token**: for OpenClaw WebSocket gateway mode (optional)

## User preferences

- Robert Matthews is the sole authorized principal
- Direct answers, fast execution, zero theater
- No emoji in chat, no theatrical preambles, no "next steps" prompts

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after changing `lib/api-spec/openapi.yaml`
- `lib/db/src/index.ts` throws if `DATABASE_URL` is not set — provision DB before starting API server
- bob.js is a pre-compiled 234KB bundle from the upstream Nova repo — do not hand-edit it; rebuild from source instead
- SOUL.md §26 governs autonomous operation: set `autonomyEnabled: false` in GOVERNANCE.json as a kill switch
- SOUL.md §24 requires anti-hallucination verification on every factual autonomous output

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Upstream Nova repo: https://github.com/paisabrazilfl-cpu/Nova-
