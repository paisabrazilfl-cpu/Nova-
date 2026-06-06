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
- `lib/db/src/schema/` — Database schema (Drizzle ORM); `integrations.ts` (credential store) + `knowledge.ts` (pgvector chunks)
- `artifacts/api-server/src/lib/{integrations,google,knowledge}.ts` — credential store, Google token mint/refresh, embed/chunk/search/ingest
- `artifacts/api-server/src/routes/{integrations,knowledge}.ts` — integration + knowledge HTTP routes (PIN-gated)
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
- Production is deployed on **Render** as web service **`Nova-`** (https://nova-sszi.onrender.com, repo `paisabrazilfl-cpu/Nova-`, branch `FINAL-BUILD-06/052026` (renamed from `replit-sync` — see "Deploy & push workflow" below), Docker, autoDeploy on). Required service env vars: `BITDEER_API_KEY`, `GEMINI_API_KEY` (chat + embeddings — see "AI providers" below), `DATABASE_URL`, `NODE_ENV=production`, `SESSION_SECRET` (without `SESSION_SECRET` the Work Tree PIN gate fails closed with 503). It uses Render-managed Postgres (`nova-db`) via the DB's **internal** connection string as `DATABASE_URL`. **Two live Nova front-ends:** `nova-sllb.onrender.com` (service `nova`, `srv-d8dlfipo3t8c73em7550`) is the URL **end users actually use** (Robert's word, authoritative) and `nova-sszi.onrender.com` (service `Nova-`) is the other. Both now deploy the **same** repo `paisabrazilfl-cpu/Nova-` branch `FINAL-BUILD-06/052026` and both have `BITDEER_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `DATABASE_URL`, `NODE_ENV`, `SESSION_SECRET`. Keep them in sync — deploy to **both** on every release. **Caution:** the `nova` service had previously been mis-repointed to the shared `omnipost` repo (which also backs `depo-provera-claim-center`, `contentflow-ai`, `psyche-hub`). **Never** push Nova code into `omnipost` — that would break those apps. To update nova-sllb, repoint *that one service* to `Nova-` and deploy (see `.agents/memory/render-service-repoint.md`). The Replit daemon distills the live Render DB via `SCRATCHPAD_DATABASE_URL` (= Render **external** string + `?sslmode=no-verify`); Render's DB IP allowlist must stay open (`0.0.0.0/0`) for the daemon to reach it. See `.agents/memory/render-postgres-connect.md`. Render free Postgres expires ~30 days after creation — upgrade the plan to keep it.

## AI providers

- Chat inference and embeddings run through the OpenAI-shaped proxy (`artifacts/api-server/src/routes/openai-proxy.ts`). `pickProvider(model)` routes any `gemini-*` model to Google's OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai`, Bearer `GEMINI_API_KEY`, leading `/v1` stripped); all other models go to OpenAI (`OPENAI_API_KEY`). The OpenAI path is untouched, so model name alone selects the provider.
- Default chat model is `gemini-2.5-flash` (the UI migration forces `settings.model` to it when not already a `gemini-*` model). Dropdown also offers `gemini-2.5-pro`, `gpt-4o`, `gpt-4o-mini`.
- Embeddings (`artifacts/api-server/src/lib/knowledge.ts` `embedConfig()`) prefer Gemini (`gemini-embedding-001` with `dimensions:1536`) when `GEMINI_API_KEY` is set, else OpenAI (`text-embedding-3-small`). Both emit 1536-dim vectors so the `vector(1536)` schema + hnsw index stay intact regardless of provider.
- **Why Gemini:** OpenAI billing is hard-blocked (429), so Robert supplied a Gemini key as the working provider. Keep both paths — do not delete the OpenAI branch.

## Deploy & push workflow (authoritative — Robert's rule)

- **Branch naming:** every push goes to a branch whose name encodes the date and what changed (e.g. `FINAL-BUILD-06/052026`). That branch must always hold the full latest project with no loss of function.
- **Render deploy branch:** the live Render `Nova-` service deploys from whatever single branch is configured on it. `replit-sync` was renamed to `FINAL-BUILD-06/052026`. When a new dated branch becomes canonical, repoint Render (`PATCH /v1/services/{id}` with `{"branch":"…"}`), then trigger and poll a deploy to `live` — a missing/stale configured branch silently stops autoDeploy (push lands on GitHub but prod never updates).
- **Push procedure:** push `main` HEAD → the dated branch on GitHub using the token-in-URL form (redact the token in logs), then ensure Render deploys it and reaches `live`, then confirm the live site.
- **Self-sufficiency:** do not ask Robert to fix things that can be fixed here — self-reflect ("can I fix this?") and if so, just do it.

## Product

- **Nova Chat**: Full-featured AI chat UI with model selection, streaming responses, markdown rendering, code highlighting, chat history
- **Workspace system**: Organizes files into Medical, Health, Dietary, Fitness, Todo, Tasks, Agents, Pictures — Medical is password-protected
- **Voice I/O**: Microphone input and TTS output
- **Deep Worker**: Submit hard problems as background jobs, retrieve results asynchronously
- **Autonomous heartbeat**: Cron-driven self-management loop that polls tasks, patches bugs, reports status
- **Anti-hallucination**: Deterministic verifier gates every factual claim before it's sent
- **Scratchpad memory**: Cross-conversation continuity. Every turn is captured; a daemon distills each conversation into `{category, title, summary, keyFacts}` and a capped digest is injected into future chats. Viewable in Settings → "Scratch pad", grouped by category (identity/health/esoteric/manifestation/quantum/tasks/general)
- **Integrations**: user-supplied credentials for Google (Gmail · Sheets · Docs · Drive, one OAuth credential group), YouTube (API key), and Instagram (Graph access token) — entered in Settings → Integrations, stored server-side in Postgres (`integration_credentials`), never echoed back (only a set/not-set status). Read endpoints under `/api/integrations/*`. Works on Render prod (no Replit-only OAuth proxy). Google access tokens are minted from a `refresh_token` (preferred, auto-refreshes) or a short-lived `access_token`.
- **Knowledge base (pgvector)**: semantic retrieval over notes/files/SOPs/leads/transcripts. `POST /api/knowledge/ingest` chunks + embeds text (OpenAI `text-embedding-3-small`, 1536-dim) into `knowledge_chunks` (hnsw cosine index); `POST /api/knowledge/search` does cosine search. The chat proxy injects best-effort retrieval context server-side (in-process, gated by `NOVA_KNOWLEDGE_RETRIEVAL!=="0"`) after memory injection — it never hard-fails the chat.
- **Ambient background ("the lady")**: a low-opacity Nova portrait (`artifacts/nova/public/assets/nova-bg.png`) sits fixed behind the chat via `#nova-bg` (z-index −1, `pointer-events:none`, ~0.18 opacity + a left-to-right dark scrim) so content always stays readable on top

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

### Agent operating protocol (authoritative — follow on every task)

1. **Self-Reflect** — before asking Robert anything, ask: "can I fix this myself?" If yes, fix it. Never ask Robert to perform an action the agent can do.
2. **Plan** — create a step-by-step plan before making changes.
3. **Execute** — perform the planned actions (code edits, commands, file updates).
4. **Observe** — check what actually happened after execution (logs, output, errors).
5. **Verify** — confirm the result works using tests, builds, logs, or browser checks.
6. **Playwright Validation** — use Playwright to open the app, click through the UI, and confirm features work in the browser.
7. **Post-Execution Review** — compare the result against the original plan after the work is complete.
8. **Plan-vs-Execution Match** — explicitly check whether the final result matches what was planned.
9. **Mismatch Detection** — find and call out any differences between intended and actual result.
10. **Root Cause Analysis** — identify the real reason something failed before patching.
11. **Correction Loop** — if something fails: read the error, patch, re-verify. Repeat until fixed.
12. **Evidence-Based Reporting** — report only what was actually observed, tested, or verified.
13. **No-Hallucination Rule** — never invent files, APIs, test results, features, or success claims.
14. **Execution Trace** — keep a record of commands run, files changed, tests performed, and browser checks completed.
15. **Acceptance Criteria** — state the exact conditions that must be true for a task to count as complete.
16. **UI Smoke Test** — quick browser test confirming the main UI loads and basic actions work.
17. **Regression Check** — confirm new changes did not break existing functionality.
18. **Automated Test Run** — run typecheck, lint, unit, integration, or build commands to verify code quality.
19. **Human-Readable Report** — final summary: what changed, what passed, what failed, what remains blocked.
20. **Reflective Alignment Check** — compare final execution outcome against the original plan and state whether they align.

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after changing `lib/api-spec/openapi.yaml`
- `lib/db/src/index.ts` throws if `DATABASE_URL` is not set — provision DB before starting API server
- bob.js is a pre-compiled 234KB bundle from the upstream Nova repo — do not hand-edit it; rebuild from source instead
- SOUL.md §26 governs autonomous operation: set `autonomyEnabled: false` in GOVERNANCE.json as a kill switch
- SOUL.md §24 requires anti-hallucination verification on every factual autonomous output
- **PIN gate must be PATH-SCOPED.** In `artifacts/api-server/src/routes/index.ts` the gate is mounted as `router.use(["/integrations", "/knowledge"], requireWtAuth)` — a pathless `router.use(requireWtAuth, subRouter)` turns `requireWtAuth` into catch-all middleware that runs for EVERY later route (it once locked the chat proxy `/api/v1/*` with `{error:"locked",needPin:true}` in prod). Keep the routers mounted separately after the scoped gate. See `.agents/memory/express-pathless-middleware-gate.md`.
- Work Tree ("Super Nova") API is PIN-gated: `POST /api/work-tree/unlock {pin}` sets a 12h httpOnly cookie; all other `/api/work-tree/*` routes require it (`requireWtAuth` in `artifacts/api-server/src/lib/work-tree-auth.ts`). PIN defaults to `22`, override via `NOVA_WORK_TREE_PIN`. Worker runs dangerous tools when `SUPER_NOVA_EXEC=1`, so the gate is what keeps unauthenticated callers out. **The same PIN gate now also protects `/api/integrations/*` and `/api/knowledge/*`** (they hold Robert's API tokens + private notes) — the unlock cookie is scoped to `/api`, so one unlock covers all three surfaces. Settings → Integrations prompts for the PIN on the first 401. (Chat KB injection runs in-process and does not pass through these gated HTTP routes, so it is unaffected.)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Upstream Nova repo: https://github.com/paisabrazilfl-cpu/Nova-
