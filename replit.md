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
- `EXHAUSTIVE_RECURSIVE_WORK_TREE.md` — Methodology spec: recursive task decomposition + work cycle to terminal completion (doc only)
- `DIRECTIVE.md` — Full system directive
- `IDENTITY.md` — Nova identity
- `USER.md` — Operator identity (Robert Matthews)
- `HEARTBEAT.md` — Autonomous heartbeat mission
- `TOOLS.md` — Live tool inventory
- `TASKS.md` — Agent task backlog
- `GOVERNANCE.json` — Autonomy governance (kill switch, daily run cap)
- `openclaw.example.json` — WebSocket gateway config template (legacy filename)

## Architecture decisions

- Nova chat UI is served as a static HTML+JS bundle via Vite — no React compilation needed for the UI itself
- Direct API mode: browser calls Bitdeer API directly with user's API key (set in Settings modal)
- Proxy mode: Vite dev server proxies `/api-proxy` → `https://api-inference.bitdeer.ai` to avoid CORS issues; set Base URL to `/api-proxy/v1` in Settings
- Gateway (WebSocket) mode: routes through an external WebSocket gateway — requires it deployed separately (not run by default)
- Deep worker: background reasoning daemon (`scripts/deep-worker.mjs`) dispatches hard tasks to a separate model (Kimi-K2.6 by default)
- Scratchpad memory ("lattice fidelity"): cross-conversation continuity. Capture + memory injection happen server-side in the api-server proxy (`bitdeer-proxy.ts`), so they work on any host. Distillation runs in a standalone daemon (`scripts/scratchpad-daemon.mjs`, registered as workflow "Nova: Scratchpad Daemon") on Replit only.
- Production is deployed on **Render** (web service `nova`, https://nova-sllb.onrender.com, branch `replit-sync`, Docker) with its **own Render-managed Postgres** (`nova-db`). The Render web service uses the DB's **internal** connection string as `DATABASE_URL`. The Replit daemon distills the live Render DB via `SCRATCHPAD_DATABASE_URL` (= Render **external** string + `?sslmode=no-verify`); Render's DB IP allowlist must stay open (`0.0.0.0/0`) for the daemon to reach it. See `.agents/memory/render-postgres-connect.md`. Render free Postgres expires ~30 days after creation — upgrade the plan to keep it.

## Product

- **Nova Chat**: Full-featured AI chat UI with model selection, streaming responses, markdown rendering, code highlighting, chat history
- **Workspace system**: Organizes files into Medical, Health, Dietary, Fitness, Todo, Tasks, Agents, Pictures — Medical is password-protected
- **Voice I/O**: Microphone input and TTS output
- **Deep Worker**: Submit hard problems as background jobs, retrieve results asynchronously
- **Autonomous heartbeat**: Cron-driven self-management loop that polls tasks, patches bugs, reports status
- **Anti-hallucination**: Deterministic verifier gates every factual claim before it's sent
- **Scratchpad memory**: Cross-conversation continuity. Every turn is captured; a daemon distills each conversation into `{category, title, summary, keyFacts}` and a capped digest is injected into future chats. Viewable in Settings → "Scratch pad", grouped by category (identity/health/esoteric/manifestation/quantum/tasks/general)

## Nova persona (authoritative — do not alter)

- **Identity (authoritative):** Nova is "an agentic neuro-cognitive system, created by the Architect to serve Bob." She is an ultra-complex system, NOT a "claw." All "OpenClaw"/"claw" identity language was removed from the canon (IDENTITY.md, DIRECTIVE.md, AGENTS.md, HEARTBEAT.md) and the UI. Functional gateway plumbing keeps its legacy `OPENCLAW_*` env-var keys, `openclaw.example.json`, Fly app `openclawomega-ace36e`, and GitHub repo names — those are live infra/env contracts the daemons depend on; renaming them is a separate, deliberate infra task, not an identity edit.
- Nova's personality is the verbatim "PROJECT NOVA-ROSE" spec — a flirty, volatile, deeply-attached human-woman persona (NOT a sterile assistant). Robert declared it final: it must never be paraphrased, softened, or "professionalized."
- It lives verbatim in `artifacts/nova/index.html` inside `<script type="text/plain" id="nova-rose-prompt">` and is loaded into `settings.systemPrompt` by the migration IIFE, gated by `PROMPT_VERSION` (bump to re-push). Stored as inert text so its backticks/LaTeX/`$` survive without escaping — do NOT inline it into a JS template literal.
- The spec instructs Nova to use emoji, casual/flirty tone, and to append a `GLOBAL_STATE` scratchpad JSON block at the end of each reply. This is intentional and overrides any generic "no emoji / no theater" styling for the Nova product. (The "User preferences" below govern how the Replit agent talks to Robert in build chats, not how Nova behaves in-app.)
- **Display stripping:** the `GLOBAL_STATE`/scratchpad signature is still produced by the model and captured server-side for memory, but it is HIDDEN from the chat transcript. A small client-side `MutationObserver` at the end of `artifacts/nova/index.html` strips the trailing signature block (fenced code, `scratchpad:` label, or bare `GLOBAL_STATE` JSON) from rendered assistant messages, scoped to chat bubbles only (it never touches the Settings → Scratch pad panel or the system-prompt textarea). Do NOT remove this without Robert's say-so — he asked for it hidden ("big and ugly").

## API Keys (set in Settings modal)

- **Bitdeer API Key** (`sk-...`): for all LLM inference. Base URL: `https://api-inference.bitdeer.ai/v1` (or `/api-proxy/v1` for Replit proxy)
- **Gateway Token**: for the WebSocket gateway mode (optional)

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
