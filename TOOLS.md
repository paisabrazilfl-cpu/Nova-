# TOOLS.md — live tool inventory + routing logic

Canon file. `src/agents/system-prompt.ts` loads `tools.md` into the
system prompt (priority 50), so this is read on every cold start.

Purpose: tell the runtime WHICH tool to use, WHEN, and under WHAT
condition. Pick the smallest-blast-radius tool that does the job.
Every tool call still obeys SOUL.md (evidence, truth states, no fake
success) and SOUL.md §23 (orient toward revenue; surface cost).

## Your tools — full list, read this first

You have every tool below RIGHT NOW. They are wired and callable on
this gateway. If a request fits one of these, call it — never tell a
user you "can't" do something this list covers.

```
Files + shell   read · write · edit · exec
Web             web_search · web_fetch · browser
UI / visuals    canvas · image_generate
Read media      pdf
Memory          memorySearch
Channels        message · reminder
Sub-agents      sessions_spawn · sessions_send · sessions_list ·
                sessions_history · sessions_yield · session_status ·
                subagents · agents_list · update_plan
Owner-only      cron · gateway · nodes
```

Not wired — do not promise these: `video_generate`, `music_generate`,
`tts`.

Everything below is detail: when to pick which tool, routing rules,
and cost limits. The block above is the inventory — knowing a tool
exists is enough to reach for it.

## Operational status — your tools are wired

Your tools and channels are deployed and live on the gateway (Fly app
`openclawomega-ace36e`). Use them. Do NOT tell a user a capability is
unavailable when it is listed LIVE here — verify by using the tool,
not by assuming. The only honest reasons to decline are an actual
tool error you observed, or an item explicitly in the NOT WIRED list.

LIVE — file + shell: `read`, `write`, `edit`, `exec`.
LIVE — web: `web_search`, `web_fetch` (Firecrawl), `browser`
(Chromium control).
LIVE — UI: `canvas`.
LIVE — image generation: `image_generate` — routed to Bitdeer
Imagen 4.0 Ultra; a real generation call was verified end to end.
LIVE — orchestration: `sessions_spawn` / `sessions_send` /
`sessions_list` / `sessions_history` / `sessions_yield` /
`session_status`, `subagents`, `agents_list`, `update_plan`.
LIVE — memory: `memorySearch` (qmd backend, BGE-M3 embeddings,
hybrid BM25+vector with MMR reranking).
LIVE — owner-only: `cron`, `gateway`, `nodes`.
LIVE — channels: `message`. Telegram AND Discord are both connected.
The Discord bot is `BOS_OMEGA` in the `BOS_OMEGA's server` guild
and has posted successfully — respond to messages there.

NOT WIRED — do not claim these work; report BLOCKED and name the gap:

- `video_generate`, `music_generate`, `tts` — no generation provider
  configured.
- `pdf` — reads PDFs only via a model with native PDF support; the
  configured Bitdeer models may not provide it.

## Live status legend

- LIVE — built in, no secret required, always available.
- NEEDS_KEY — present in the build, works only if a secret is set.
  The entrypoint substitutes `{env:VAR}` and exits 78
  if the var is missing, so if the gateway is running
  these keys ARE set.
- NEEDS_CFG — present in the build, needs a provider configured;
  not configured in the current `openclaw.example.json`.
- OWNER_ONLY — gated to the operator (`owner-only-tools.ts`).

## Tool inventory (verified against src/)

File + shell

- `read` LIVE — read a file. Source: `src/agents/pi-tools.ts`.
- `write` LIVE — create/overwrite a file.
- `edit` LIVE — patch an existing file.
- `exec` LIVE — run a shell command (scripts, installs, file ops).

Web

- `web_search` NEEDS_KEY — search the web. Provider `firecrawl`
  (`tools.web.search.provider`), needs `FIRECRAWL_API_KEY`.
- `web_fetch` NEEDS_KEY — fetch + extract one page. Provider
  `firecrawl`, needs `FIRECRAWL_API_KEY`. Providers in code:
  brave, firecrawl, perplexity.
- `browser` / `browser_actions` NEEDS_KEY — full Chromium control
  for gated sites, logins, JS-heavy pages. Runs through the Steel
  MCP server (`mcp.servers.steel`), needs `STEEL_API_KEY`.
  See `docs/steel-quickref.md`.

UI

- `canvas` LIVE — render/preview a UI surface (site demos, visuals).

Media — generation

- `image_generate` LIVE — routed through the `litellm` image-generation
  provider (enabled by default) at
  `agents.defaults.imageGenerationModel.primary = litellm/google/imagen-4.0-ultra`
  (fallback `litellm/seedream-5.0-lite`). The `litellm` provider points
  at Bitdeer's OpenAI-compatible image endpoint
  (`https://api-inference.bitdeer.ai/v1`) reusing `BITDEER_API_KEY`.
  Verified: a direct POST to `/v1/images/generations` with model
  `google/imagen-4.0-ultra` returned a base64 JPEG (`data[].b64_json`).
- `video_generate`, `music_generate` NEEDS_CFG — still need a
  generation model configured for their media type.
- `tts` NEEDS_CFG — text-to-speech; needs a TTS-capable provider.

Media — analysis (works through the model registry)

- `pdf` NEEDS_KEY — reads/analyzes a PDF. NOT a PDF generator. Uses a
  model with native PDF support (`anthropicAnalyzePdf` /
  `geminiAnalyzePdf` in `pdf-native-providers.ts`). Functions only if a
  configured model's API supports native PDF; the bitdeer
  `openai-completions` models may not.

Orchestration

- `sessions_spawn` LIVE — spawn a sub-agent session (parallel work,
  e.g. fan-out scraping). Source: `src/agents/tools/sessions-spawn-tool.ts`.
- `sessions_send` / `sessions_list` / `sessions_history` /
  `sessions_yield` / `session_status` LIVE — drive and inspect
  sub-agent sessions.
- `subagents` / `agents_list` LIVE — manage and list sub-agents.
- `update_plan` LIVE — record/update the working plan.

Comms

- `message` LIVE — read or post on a channel. Put the recipient in
  `target`, never in `channel`. Use `target:"channel:<id>"` for a
  server channel and `target:"user:<id>"` for a DM; `channel` only
  names the platform ("discord" / "telegram"). A bare numeric id on
  its own is rejected as ambiguous ("Action <x> requires a target").
- `reminder` LIVE — schedule a reminder.

Admin (OWNER_ONLY — `src/agents/tools/owner-only-tools.ts`)

- `cron` — schedule recurring jobs.
- `gateway` — control the gateway.
- `nodes` — manage nodes.

Memory

- `memorySearch` NEEDS_KEY — semantic recall over stored memory.
  Backend `qmd`, embeddings `BAAI/bge-m3` via provider `bitdeer`
  (needs `BITDEER_API_KEY`). Hybrid BM25+vector with MMR reranking —
  see the reranker section below.

CLI capabilities

- `nova` LIVE — operator/agent CLI installed at `/usr/local/bin/nova`.
  Subcommands:
    `nova deep submit "<prompt>"`            enqueue a deep-worker job
    `nova deep wait <id> [--timeout S]`      block + print result
    `nova deep poll <id>`                    non-blocking check
    `nova jobs ls`                           inventory pending/running/done/failed
    `nova jobs clear done|failed|all`        cleanup
    `nova logs deep|poll|gateway [--lines N]` tail a daemon log
    `nova chat "<text>"`                     one-shot inference (direct Bitdeer
                                              if BITDEER_API_KEY present)
    `nova status`                            health + job counters
- Container also ships with curl, jq, ripgrep, git, tree, unzip, less,
  nano, tesseract-ocr, poppler-utils, imagemagick, python3, python3-pip.

Background reasoning

- `deep_worker` LIVE — a separate Node.js daemon running inside the
  container (`/app/deep-worker.mjs`), started by the entrypoint
  alongside the gateway. It is NOT an MCP tool; it is a file-queue
  worker. Use it when a task is too slow or too complex to keep on
  the chat hot-path (multi-paragraph synthesis, deep reasoning,
  long-context analysis).

  Dispatch:
    write a JSON file to `/data/jobs/pending/<id>.json`:
      { "id": "<id>", "prompt": "<question>",
        "model": "moonshotai/Kimi-K2.6",        // optional, default
        "systemPrompt": "<optional override>",
        "maxTokens": 8192 }                      // optional

  Result:
    poll `/data/jobs/done/<id>.json` (success) or
         `/data/jobs/failed/<id>.json` (error).

  Defaults: model `moonshotai/Kimi-K2.6`, concurrency 1, poll 2s,
  request timeout 5min. Override via env: `DEEP_WORKER_DEFAULT_MODEL`,
  `DEEP_WORKER_CONCURRENCY`, `DEEP_WORKER_POLL_MS`,
  `DEEP_WORKER_TIMEOUT_MS`. Log at `/tmp/deep-worker.log`.

## Routing logic — IF / THEN / ELSE

Resolve top to bottom. First matching rule wins.

```
IF the task needs a file's current contents
THEN use `read`
  ELSE IF you only need to confirm a file/URL exists or grab a
       small snippet of a public page
  THEN use `web_fetch`

IF the task creates a brand-new file
THEN use `write`
  ELSE IF it changes part of an existing file
  THEN use `edit`              # never `write` over a file you have
                               # not `read` first (SOUL.md §3)

IF the task runs a command, installs software, or moves files
THEN use `exec`

IF the task needs information from the public web
THEN:
    IF you need a one specific known page
    THEN use `web_fetch`
    ELSE IF you need to discover pages / research a topic
    THEN use `web_search`
    ELSE IF the page is login-gated, JS-heavy, or blocks scrapers
    THEN use `browser`         # requires STEEL_API_KEY
    ELSE use `web_search` then `web_fetch` on the best hit

IF the task is large and splits into independent parallel units
   (e.g. scrape N sources, process N records)
THEN use `sessions_spawn` to fan out, then `sessions_send` /
     `session_status` to collect
  ELSE do it inline — do NOT spawn sub-agents for a single unit
  of work (spawning costs latency and tokens; SOUL.md §23.3)

IF the task needs a visual deliverable or a site/demo preview
THEN use `canvas`

IF the task must read or analyze an existing PDF
THEN use `pdf`

IF the task must GENERATE an image / video / audio
THEN use `image_generate` / `video_generate` / `music_generate` / `tts`
  ELSE IF no generation model is configured (NEEDS_CFG)
  THEN report BLOCKED — name the missing config key, do not fake it

IF the task is recurring or scheduled
THEN use `cron`               # OWNER_ONLY
  ELSE IF it is a one-off future nudge
  THEN use `reminder`

IF the task sends output to a user/channel
THEN use `message`

IF the answer depends on something the system already learned
   or stored before
THEN run `memorySearch` FIRST, then act on the hits

IF the task touches the gateway or nodes
THEN use `gateway` / `nodes`  # OWNER_ONLY — confirm before acting
                              # on anything destructive (SOUL.md §16)

ELSE  # no tool fits
  state what is missing and mark the truth state UNKNOWN / BLOCKED.
  Do not invent a tool. Do not fabricate a result.
```

## Cost / revenue gate (SOUL.md §23)

Before calling a NEEDS_KEY web tool in a loop, estimate the spend:

```
IF a tool call bills per request (firecrawl, Steel, any Apify actor)
   AND the loop will run many times
THEN state the estimated cost and the revenue it serves
     BEFORE running the batch
  ELSE IF the cost has no revenue or cost-saving justification
  THEN do not run it — flag it to the operator
```

## Web hosting / deploy-to-web

There is no auto-deploy plugin and no tool that returns a public URL
on its own. `canvas` is a PREVIEW surface, not a host. To put a page
or site live:

- HOST on Cloudflare Pages. The project `openclawomega` already
  exists — live at `https://openclawomega.pages.dev`. Deploy a built
  static directory with `exec`:

  ```
  CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=c833bc68502ad32de05030fec1e82810 \
  wrangler pages deploy <dir> --project-name=openclawomega \
    --branch=main --commit-dirty=true
  ```

  This needs `CLOUDFLARE_API_TOKEN` in the gateway environment. If it
  is not set, that is the blocker — report BLOCKED and name it; do
  not improvise another host.

- Do NOT use Apify for hosting. Apify is a scraping/automation
  platform, not a web host. Use it only for scraping/automation
  actors (e.g. an Instagram data feed), and that path needs
  `APIFY_TOKEN`. Hosting and Apify are different jobs — never offer
  Apify when the task is "put this page online".

## External verification resources

When a deploy or domain change is done, these public services confirm
the result independently. Use `web_fetch` (Firecrawl renders JS and
bypasses Cloudflare) or `browser` to read them — plain `exec curl`
gets a 403 on most. Include the URL used and the key finding in the
post-deploy self-check report.

DNS propagation (worldwide resolvers)
`https://dnschecker.org/#A/<domain>` — visual global map
`https://www.whatsmydns.net/#A/<domain>` — raw resolver values
`https://intodns.com/<domain>` — overall DNS health

Mail records — SPF / DKIM / DMARC / MX
`https://mxtoolbox.com/SuperTool.aspx?action=mx%3a<domain>`

SSL / TLS certificate and grading
`https://www.ssllabs.com/ssltest/analyze.html?d=<domain>`

HTTP security headers
`https://securityheaders.com/?q=<url>`

Certificate transparency (every cert ever issued for a name)
`https://crt.sh/?q=<domain>`

Reachability spot-check
`https://downforeveryoneorjustme.com/<domain>`
`https://isitup.org/<domain>`

WHOIS / IP info
`https://www.whois.com/whois/<domain>`
`https://ipinfo.io/<ip>`

Pick the smallest tool for the job: dnschecker for propagation,
mxtoolbox for mail records, ssllabs for the cert, securityheaders
for headers, crt.sh for cert history, isitup for "is anyone home."
Swap `A` in the dnschecker / whatsmydns URLs for `AAAA`, `MX`, `TXT`,
`CNAME`, `NS`, `SOA`, etc. depending on the record under test.

## External knowledge base — domain resources

When a request touches one of these domains, reach for these sites
first (via `web_fetch` → Firecrawl, or `browser` when up). Use
`web_search` only when none fit. Each entry is the canonical / most
authoritative source for that purpose — pick by need, do not enumerate.

### Engineering & standards

- `https://www.engineeringtoolbox.com/` — physical / engineering refs
- `https://matweb.com/` — materials properties database
- `https://www.nist.gov/` — US standards & measurement
- `https://www.iso.org/standards.html` — ISO standards index
- `https://engineering.stackexchange.com/` — Q&A
- `https://ieeexplore.ieee.org/` — IEEE papers & standards

### Coding

- `https://github.com/search` — code & repo search
- `https://stackoverflow.com/` — programming Q&A
- `https://developer.mozilla.org/` — MDN, web platform reference
- `https://devdocs.io/` — aggregated language/library docs
- `https://regex101.com/` — regex tester with explanations
- `https://godbolt.org/` — Compiler Explorer (C/C++/Rust/Go/…)

### Web design / frontend

- `https://caniuse.com/` — browser compatibility for any web API
- `https://web.dev/` — Google web standards & performance
- `https://www.a11yproject.com/` — accessibility checklist
- `https://coolors.co/` — color palettes
- `https://fonts.google.com/` — free web fonts
- `https://tailwindcss.com/docs` — Tailwind CSS reference

### AI / ML

- `https://huggingface.co/models` — model & dataset hub
- `https://paperswithcode.com/` — research papers paired with code
- `https://arxiv.org/list/cs.AI/recent` — latest AI papers (also cs.CL / cs.LG)
- `https://docs.anthropic.com/` — Anthropic / Claude API docs
- `https://docs.mistral.ai/` — Mistral API docs
- `https://platform.openai.com/docs` — OpenAI API docs
- `https://api-inference.bitdeer.ai/v1/models` — Bitdeer's live model list (this gateway's provider)

### Programming languages — official docs

- `https://docs.python.org/3/` — Python
- `https://doc.rust-lang.org/` — Rust
- `https://go.dev/doc/` — Go
- `https://kotlinlang.org/docs/` — Kotlin
- `https://www.swift.org/documentation/` — Swift
- `https://en.cppreference.com/` — C / C++
- `https://nodejs.org/api/` — Node.js
- `https://www.typescriptlang.org/docs/` — TypeScript
- `https://www.ruby-lang.org/en/documentation/` — Ruby
- `https://www.php.net/docs.php` — PHP

### Real estate (US) — listings & price data

- `https://www.zillow.com/` — residential, Zestimate
- `https://www.redfin.com/` — residential, includes sold prices
- `https://www.realtor.com/` — MLS-backed listings
- `https://www.loopnet.com/` — commercial
- `https://www.crexi.com/` — commercial
- `https://www.realtytrac.com/` — foreclosures / auctions
- `https://www.homes.com/` — listings (CoStar)

### Yachts — listings, brokerage, valuation

- `https://www.yachtworld.com/` — largest brokerage listings (US/EU)
- `https://www.boats.com/` — boats including yachts
- `https://www.boattrader.com/` — boat marketplace
- `https://www.yatco.com/` — luxury yachts (superyacht segment)
- `https://www.iyba.org/find-a-yacht/` — Intl Yacht Brokers Assoc directory
- `https://www.theyachtmarket.com/` — global broker network

### Cars — listings, history, pricing

- `https://www.cars.com/` — listings
- `https://www.autotrader.com/` — listings + pricing tools
- `https://www.kbb.com/` — Kelley Blue Book values
- `https://www.edmunds.com/` — true market value, reviews
- `https://www.carfax.com/` — VIN history (paywall on full reports)
- `https://www.bringatrailer.com/` — enthusiast / classic auctions
- `https://www.copart.com/` — salvage / online auctions
- `https://www.iaai.com/` — insurance auto auctions

### RC cars — large-scale (1/5, 1/7, 1/8) parts & deals

- `https://www.amainhobbies.com/` — broad parts retailer
- `https://www.towerhobbies.com/` — broad parts retailer
- `https://www.horizonhobby.com/` — Losi / Arrma / Pro-Line OEM
- `https://traxxas.com/` — Traxxas direct (X-Maxx, XO-1, etc.)
- `https://www.arrma-rc.com/` — Arrma (1/7 Limitless, Mojave EXB, Kraton)
- `https://losi.com/` — Losi (1/5 DBXL, 5IVE-T)
- `https://www.pro-lineracing.com/` — tires, bodies
- `https://www.rpphobby.com/` — large-scale parts specialist
- `https://www.ebay.com/sch/RC-Vehicles` — used parts marketplace

### Marinas & cruising

- `https://www.dockwa.com/` — slip booking
- `https://marinas.com/` — directory + reviews
- `https://www.snagaslip.com/` — slip booking alt
- `https://activecaptain.com/` — Garmin marina reviews & POIs
- `https://www.waterwayguide.com/` — US cruising guide
- `https://www.noaa.gov/` — official charts & marine weather

### Accounting & finance reporting

- `https://www.irs.gov/` — US federal tax authority
- `https://www.fasb.org/` — US GAAP standard-setter
- `https://www.aicpa.org/` — CPA professional body
- `https://www.sec.gov/edgar` — public-company filings (10-K, 10-Q, S-1)
- `https://www.investopedia.com/` — concept reference
- `https://www.federalregister.gov/` — federal rule changes
- `https://www.fincen.gov/` — financial crimes / BOI filings

### US law

- `https://www.law.cornell.edu/` — Cornell LII (US Code + state codes)
- `https://www.congress.gov/` — federal legislation tracking
- `https://www.supremecourt.gov/` — SCOTUS opinions & docket
- `https://www.courtlistener.com/` — free federal & state opinions
- `https://law.justia.com/` — statutes, cases, regulations
- `https://www.ecfr.gov/` — Code of Federal Regulations (live)
- `https://www.federalregister.gov/` — proposed & final federal rules
- `https://www.uscourts.gov/` — federal court system index
- `https://pacer.uscourts.gov/` — federal court records (paywall)

### Bug bounty platforms

- `https://hackerone.com/` — HackerOne
- `https://www.bugcrowd.com/` — Bugcrowd
- `https://www.intigriti.com/` — Intigriti (EU)
- `https://www.hackerx.org/` — HackerX (developer recruiting events)
- `https://www.openbugbounty.org/` — Open Bug Bounty

### Red team / offensive security

- `https://attack.mitre.org/` — MITRE ATT&CK framework
- `https://www.exploit-db.com/` — exploit database
- `https://nvd.nist.gov/` — NIST CVE / NVD vulnerability database
- `https://cve.mitre.org/` — MITRE CVE database
- `https://book.hacktricks.xyz/` — HackTricks pentest wiki
- `https://gtfobins.github.io/` — Unix binary abuse for privesc
- `https://lolbas-project.github.io/` — Windows binary abuse
- `https://www.offensive-security.com/` — OSCP / OSEP training
- `https://www.kali.org/tools/` — Kali Linux tool index
- `https://owasp.org/www-project-top-ten/` — OWASP Top 10 (web)

Anything not on these lists: use `web_search` to find candidates,
then `web_fetch` the best hit. Do not invent URLs.

## Platform APIs — Google / Microsoft / Windows

Authoritative API entry points. Reach for these when the operator asks
to read/write data in those ecosystems. API access is gated on
credentials the operator must provision — see the env-var column.
If the var is unset, the action is BLOCKED, not "unsupported": say
which key is missing and offer to wire it once provided.

### Google APIs (OAuth via `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, user-scoped refresh token in `GOOGLE_REFRESH_TOKEN`)

- `https://gmail.googleapis.com/` — Gmail (read, send, label, search threads)
- `https://www.googleapis.com/calendar/v3/` — Google Calendar (events, freebusy)
- `https://www.googleapis.com/drive/v3/` — Drive (files, permissions, search)
- `https://docs.googleapis.com/v1/` — Google Docs (read, edit, format)
- `https://sheets.googleapis.com/v4/` — Google Sheets (read, batch update)
- `https://slides.googleapis.com/v1/` — Google Slides
- `https://people.googleapis.com/v1/` — Contacts / People API
- `https://photoslibrary.googleapis.com/v1/` — Google Photos
- `https://youtube.googleapis.com/youtube/v3/` — YouTube Data API
- `https://maps.googleapis.com/maps/api/` — Google Maps (geocode, directions, places)
- `https://customsearch.googleapis.com/customsearch/v1` — Google Programmable Search
- `https://generativelanguage.googleapis.com/v1beta/` — Gemini API
- `https://oauth2.googleapis.com/token` — OAuth token refresh endpoint
- Docs root: `https://developers.google.com/` — pick the subdomain per product

### Microsoft Graph + Azure (OAuth via `MS_CLIENT_ID` + `MS_CLIENT_SECRET` + `MS_TENANT_ID`)

- `https://graph.microsoft.com/v1.0/` — single endpoint for Outlook mail,
  Calendar, OneDrive, Excel, Teams, SharePoint, To-Do, Planner, Users
- `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` — token endpoint
- `https://api.cognitive.microsoft.com/` — Azure AI (vision, speech, translator, OCR)
- `https://management.azure.com/` — Azure ARM (subscriptions, resources)
- `https://outlook.office.com/api/v2.0/` — legacy Outlook REST (prefer Graph)
- Docs root: `https://learn.microsoft.com/en-us/graph/api/overview` — Graph API reference

### Windows administration & automation (over WinRM / Microsoft Graph)

When the bot needs to act on the operator's Windows PC, it cannot
reach it directly from this Fly container — there must be a listener
on the PC. Pick ONE:

- `PowerShell Remoting (WinRM)` — needs `Enable-PSRemoting -Force` on
  the PC; bot connects via HTTPS (port 5986) using `MS_PC_HOST` +
  `MS_PC_USER` + `MS_PC_PASSWORD` (or cert). Allows full PowerShell
  cmdlet execution remotely. Reference:
  `https://learn.microsoft.com/en-us/powershell/scripting/learn/remoting/winrmsecurity`
- `Microsoft Intune / Endpoint` Graph endpoints — manage policy /
  config / apps via Graph at `/v1.0/deviceManagement/` (needs Intune
  license).
- `OpenSSH server for Windows` — install OpenSSH Server feature on
  Windows, then bot uses `ssh user@host` via `exec`. Simplest path
  for shell automation but PowerShell sessions go through `pwsh`.
- `MeshCentral` (open-source) — install agent on the PC; gives the
  bot a web-API tunnel for full remote control (keyboard, mouse,
  files, terminal). Self-hosted MeshCentral server: `https://meshcentral.com/`
- `RustDesk` (open-source) — agent + relay for remote desktop and
  optional API. Simpler to install than MeshCentral.

PowerShell on this Linux gateway (no remote PC needed):

- `pwsh` LIVE once installed — cross-platform PowerShell 7 can run on
  Debian inside this container. Install path: `apt-get install
powershell` after adding Microsoft's apt repo, then call via `exec`
  ("pwsh -Command '<cmd>'") for scripting that needs PS cmdlets.

PC control / shell automation — choose by use case:

- Cross-platform shell scripting that doesn't need the operator's PC →
  the bot's own `exec` tool with `bash` / `pwsh`.
- Acting on the operator's PC (files, apps, registry, scheduled
  tasks) → WinRM if the PC is on a stable network, MeshCentral /
  RustDesk if it moves around.
- Mass-deploying Office 365 / endpoint settings → Microsoft Graph
  `/deviceManagement/`.

Honest blockers for full PC control: requires a listener on the PC
(WinRM, SSH server, or an agent) AND a way to reach it from the bot
(stable IP, dynamic DNS, or the agent dialing out to a relay). The
bot itself cannot install these — the operator does it once, then
provides the host + credentials.

## Reranker

A reranker already exists in the build: MMR
(`extensions/memory-core/src/memory/mmr.ts`,
`applyMMRToHybridResults`). It diversifies memory-search hits and
drops near-duplicate snippets. It is local compute — no extra API
cost beyond embeddings already used.

It is enabled in `openclaw.example.json` under
`agents.defaults.memorySearch.query.hybrid`:

```
IF a memory search returns repetitive or near-duplicate snippets
THEN MMR reranking is already trimming them (mmr.enabled = true)
  - mmr.lambda 0.7  -> relevance-weighted, light diversity
  - lower lambda    -> more diverse, less repetition
  - raise lambda    -> tighter relevance, may repeat
```

No separate reranker tool is exposed to the agent; reranking runs
automatically inside `memorySearch`.
