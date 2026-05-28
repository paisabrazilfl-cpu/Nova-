#!/usr/bin/env node
// OpenClaw Omega — event poller daemon.
//
// A real long-running process (not a directive the model reads). It is
// launched in the background by the entrypoint alongside the gateway.
// Every interval it scans operational sources for NEW events and queues
// each one as a PENDING task in the agent's backlog (TASKS.md). The
// heartbeat loop then drains those tasks.
//
// Detection is deterministic: pure code, no model, no randomness. The
// poller never calls the agent and never spends tokens — it only
// detects and queues. The agent is spent only on real events.
//
// Sources:
//   - gateway log errors (zero-secret, always on)
//   - cron job failures   (zero-secret, always on)
//   - GitHub commits + CI (active only if the repo is reachable —
//     public, or GITHUB_TOKEN/GH_TOKEN is set; skipped gracefully
//     otherwise)
//
// Pipeline:  poller (detect) -> TASKS.md (queue) -> heartbeat (execute)

import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data";
const WORKSPACE = path.join(STATE_DIR, "workspace");
const TASKS_FILE = path.join(WORKSPACE, "TASKS.md");
const STATE_FILE = path.join(STATE_DIR, ".poll-state.json");
const CRON_STATE_FILE = path.join(STATE_DIR, "cron", "jobs-state.json");
const CRON_JOBS_FILE = path.join(STATE_DIR, "cron", "jobs.json");
const GOVERNANCE_FILE = path.join(WORKSPACE, "GOVERNANCE.json");
const LEDGER_FILE = path.join(WORKSPACE, "LEDGER.jsonl");
const LOG_DIR = process.env.OPENCLAW_LOG_DIR || "/tmp/openclaw";
const INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 600000); // 10 min
const GITHUB_REPO = process.env.OPENCLAW_POLL_REPO || "paisabrazilfl-cpu/openclawomega";
const GITHUB_BRANCH = process.env.OPENCLAW_POLL_BRANCH || "claude/connect-external-repo-FBe7O";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const LOG_ERROR_RE =
  /\[error\]|\bERROR\b|EACCES|crashloop|unhandledRejection|unhandled rejection|\bFATAL\b|lane task error|crashed/i;

// Known non-fatal noise — error lines matching this are NOT queued as
// tasks. The optional Steel MCP server fails to start in this image
// (isolated to one MCP plugin; the gateway and the other plugins are
// unaffected). Without this filter the poller re-queues it on every
// restart and the heartbeat loop burns autonomous runs re-investigating
// a resolved non-issue. Anchored on the steel server so any *other*
// MCP/startup failure still surfaces normally.
const LOG_IGNORE_RE =
  /(failed to start server|MCP error|Connection closed)[^\n]*\bsteel\b|\bsteel\b[^\n]*(failed to start|MCP error|Connection closed)/i;

// Agent-runtime self-noise. The embedded agent's own error-handling
// machinery — context compaction, model failover, request timeouts,
// empty-response retries — logs lines that match LOG_ERROR_RE but are
// the runtime working as designed, not external faults to patch.
// Queuing them creates a feedback loop: a heartbeat run that overflows
// its context logs an error, the poller queues it as a task, the next
// heartbeat loads a larger backlog and overflows worse. Anything the
// runtime can recover from on its own is filtered here; genuine
// crashes (unhandledRejection, EACCES, crashloop) still surface.
const RUNTIME_NOISE_RE =
  /context overflow|prompt too large|job execution timed out|failover decision|abort settle timed out|empty response|incomplete turn|auto-compaction|surface_error/i;

function log(msg) {
  console.log(`[poll] ${new Date().toISOString()} ${msg}`);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      logOffsets: {},
      cronErrorCounts: {},
      lastCommitSha: null,
      lastRunId: null,
      githubDisabled: false,
    };
  }
}

function saveState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// --- Source 1: gateway log errors ------------------------------------

function pollLogErrors(state) {
  const events = [];
  let files = [];
  try {
    files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => /^openclaw-.*\.log$/.test(f))
      .map((f) => path.join(LOG_DIR, f));
  } catch {
    return events; // log dir not present yet
  }
  for (const file of files) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    const prev = state.logOffsets[file] ?? 0;
    // File rotated/truncated — restart from 0.
    const start = prev > size ? 0 : prev;
    if (size <= start) {
      state.logOffsets[file] = size;
      continue;
    }
    let chunk = "";
    try {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      chunk = buf.toString("utf8");
    } catch {
      continue;
    }
    state.logOffsets[file] = size;
    const hits = chunk
      .split("\n")
      .filter(
        (line) =>
          LOG_ERROR_RE.test(line) &&
          !line.includes("[poll]") &&
          !LOG_IGNORE_RE.test(line) &&
          !RUNTIME_NOISE_RE.test(line),
      )
      .slice(0, 25);
    if (hits.length > 0) {
      events.push({
        source: "runtime-log",
        priority: "P1",
        title: `${hits.length} new error line(s) in ${path.basename(file)}`,
        detail:
          "The runtime poller found new error/crash lines in the gateway log. " +
          "Investigate the root cause per SOUL.md §6 and patch it.\n\n" +
          hits.map((h) => `  ${h.trim()}`).join("\n"),
      });
    }
  }
  return events;
}

// --- Source 2: cron job failures -------------------------------------

function pollCronFailures(state) {
  const events = [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(CRON_STATE_FILE, "utf8"));
  } catch {
    return events; // no cron state yet
  }
  const jobs = data?.jobs ?? {};
  for (const [jobId, rec] of Object.entries(jobs)) {
    // The heartbeat job's own failures are never queued as tasks. A task
    // that asks the heartbeat to repair the heartbeat is circular, and it
    // bloats the very backlog the next heartbeat run must load — making
    // that run more likely to fail. Heartbeat health is surfaced through
    // logs and the governance run-cap, not the task queue.
    if (/heartbeat/i.test(jobId)) {
      state.cronErrorCounts[jobId] = Number(rec?.state?.consecutiveErrors ?? 0);
      continue;
    }
    const st = rec?.state ?? {};
    const consecutive = Number(st.consecutiveErrors ?? 0);
    const prev = Number(state.cronErrorCounts[jobId] ?? 0);
    if (consecutive > prev) {
      events.push({
        source: "cron",
        priority: "P1",
        title: `cron job "${jobId}" failing (${consecutive} consecutive error(s))`,
        detail:
          `The scheduled job "${jobId}" failed. Last error:\n  ${st.lastError ?? "(none recorded)"}\n` +
          "Diagnose why the job fails and fix it, or report BLOCKED with the reason.",
      });
    }
    state.cronErrorCounts[jobId] = consecutive;
  }
  return events;
}

// --- Source 3: GitHub commits + CI (graceful if unreachable) ---------

async function ghFetch(urlPath) {
  const headers = { "User-Agent": "openclaw-omega-poller", Accept: "application/vnd.github+json" };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    return await fetch(`https://api.github.com${urlPath}`, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function pollGitHub(state) {
  const events = [];
  if (state.githubDisabled) return events;
  try {
    const commitsRes = await ghFetch(
      `/repos/${GITHUB_REPO}/commits?sha=${encodeURIComponent(GITHUB_BRANCH)}&per_page=5`,
    );
    if (commitsRes.status === 401 || commitsRes.status === 403 || commitsRes.status === 404) {
      state.githubDisabled = true;
      log(
        `GitHub polling disabled: repo not reachable (HTTP ${commitsRes.status}). ` +
          "Set GITHUB_TOKEN with repo read access to enable commit/CI polling.",
      );
      return events;
    }
    if (commitsRes.ok) {
      const commits = await commitsRes.json();
      const head = Array.isArray(commits) && commits[0] ? commits[0].sha : null;
      if (head && state.lastCommitSha && head !== state.lastCommitSha) {
        const fresh = [];
        for (const c of commits) {
          if (c.sha === state.lastCommitSha) break;
          fresh.push(`  ${c.sha.slice(0, 7)} ${(c.commit?.message ?? "").split("\n")[0]}`);
        }
        events.push({
          source: "github-commit",
          priority: "P2",
          title: `${fresh.length} new commit(s) on ${GITHUB_BRANCH}`,
          detail: "New commits landed:\n" + fresh.join("\n"),
        });
      }
      if (head) state.lastCommitSha = head;
    }

    const runsRes = await ghFetch(
      `/repos/${GITHUB_REPO}/actions/runs?branch=${encodeURIComponent(GITHUB_BRANCH)}&per_page=1`,
    );
    if (runsRes.ok) {
      const runs = await runsRes.json();
      const run = runs?.workflow_runs?.[0];
      if (run && run.id !== state.lastRunId) {
        state.lastRunId = run.id;
        if (run.status === "completed" && run.conclusion && run.conclusion !== "success") {
          events.push({
            source: "github-ci",
            priority: "P1",
            title: `CI run failed: ${run.name} (${run.conclusion})`,
            detail:
              `GitHub Actions run #${run.run_number} concluded "${run.conclusion}".\n` +
              `URL: ${run.html_url}\nInvestigate the failure and fix it.`,
          });
        }
      }
    }
  } catch (e) {
    log(`GitHub poll error (non-fatal): ${e.message}`);
  }
  return events;
}

// --- Outcome ledger --------------------------------------------------

function appendLedger(rec) {
  try {
    fs.appendFileSync(
      LEDGER_FILE,
      `${JSON.stringify({ ts: new Date().toISOString(), source: "poller", ...rec })}\n`,
    );
  } catch (e) {
    log(`ledger append failed (non-fatal): ${e.message}`);
  }
}

// --- Governance enforcement ------------------------------------------

// Set enabled on every heartbeat cron job in the store, atomically.
function setHeartbeatJobEnabled(enabled) {
  let store;
  try {
    store = JSON.parse(fs.readFileSync(CRON_JOBS_FILE, "utf8"));
  } catch {
    return false;
  }
  let changed = false;
  for (const job of store.jobs ?? []) {
    const isHb = /heartbeat/i.test(job.id ?? "") || /heartbeat/i.test(job.name ?? "");
    if (isHb && job.enabled !== enabled) {
      job.enabled = enabled;
      job.updatedAtMs = Date.now();
      changed = true;
    }
  }
  if (changed) {
    const tmp = `${CRON_JOBS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, CRON_JOBS_FILE);
  }
  return changed;
}

// Enforce GOVERNANCE.json: a hard kill switch and a daily run cap on
// autonomous heartbeat runs. On breach the poller disables the
// heartbeat cron job; when conditions clear it re-enables it.
function enforceGovernance(state) {
  const events = [];
  let gov;
  try {
    gov = JSON.parse(fs.readFileSync(GOVERNANCE_FILE, "utf8"));
  } catch {
    return events; // no governance file -> nothing enforced
  }

  const today = new Date().toISOString().slice(0, 10);
  if (state.runCountDate !== today) {
    state.runCountDate = today;
    state.runCountToday = 0;
  }

  // Count autonomous heartbeat runs by watching the cron job's lastRunAtMs.
  let lastRunAtMs = 0;
  try {
    const cs = JSON.parse(fs.readFileSync(CRON_STATE_FILE, "utf8"));
    for (const [jid, rec] of Object.entries(cs.jobs ?? {})) {
      if (/heartbeat/i.test(jid)) {
        lastRunAtMs = Math.max(lastRunAtMs, Number(rec?.state?.lastRunAtMs ?? 0));
      }
    }
  } catch {
    /* no cron state yet */
  }
  if (lastRunAtMs > (state.lastHeartbeatRunAtMs ?? 0)) {
    if (state.lastHeartbeatRunAtMs) state.runCountToday = (state.runCountToday ?? 0) + 1;
    state.lastHeartbeatRunAtMs = lastRunAtMs;
  }

  const cap = Number(gov.dailyAutonomousRunCap ?? 0);
  const autonomyOff = gov.autonomyEnabled === false;
  const overCap = cap > 0 && (state.runCountToday ?? 0) >= cap;
  const shouldDisable = autonomyOff || overCap;

  if (shouldDisable && !state.pollerDisabledHeartbeat) {
    setHeartbeatJobEnabled(false);
    state.pollerDisabledHeartbeat = true;
    const reason = autonomyOff
      ? "autonomyEnabled=false (kill switch)"
      : `daily autonomous run cap reached (${state.runCountToday}/${cap})`;
    log(`GOVERNANCE: disabling heartbeat job — ${reason}`);
    appendLedger({
      kind: "governance",
      action: "autonomy-disabled",
      reason,
      runsToday: state.runCountToday,
      cap,
    });
    events.push({
      source: "governance",
      priority: "P1",
      title: `autonomy disabled by governance — ${reason}`,
      detail:
        `The poller disabled the heartbeat cron job. Reason: ${reason}.\n` +
        "Re-enable by editing GOVERNANCE.json (autonomyEnabled / dailyAutonomousRunCap). " +
        "The cap counter resets at UTC midnight and the poller re-enables the job automatically.",
    });
  } else if (!shouldDisable && state.pollerDisabledHeartbeat) {
    setHeartbeatJobEnabled(true);
    state.pollerDisabledHeartbeat = false;
    log("GOVERNANCE: conditions cleared — re-enabled heartbeat job");
    appendLedger({
      kind: "governance",
      action: "autonomy-restored",
      runsToday: state.runCountToday,
      cap,
    });
  }
  return events;
}

// --- Task queuing ----------------------------------------------------

function nextTaskId(text) {
  let max = 0;
  for (const m of text.matchAll(/T-(\d{4,})/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return `T-${String(max + 1).padStart(4, "0")}`;
}

function queueTasks(events) {
  if (events.length === 0) return 0;
  let text;
  try {
    text = fs.readFileSync(TASKS_FILE, "utf8");
  } catch {
    log(`TASKS.md not found at ${TASKS_FILE}; cannot queue ${events.length} event(s)`);
    return 0;
  }
  const today = new Date().toISOString().slice(0, 10);
  let queued = 0;
  for (const ev of events) {
    const id = nextTaskId(text);
    const block =
      `### ${id}  [PENDING]  ${ev.priority}\n` +
      `desc: [poller:${ev.source}] ${ev.title}\n` +
      ev.detail
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n") +
      `\ncreated: ${today}\nclaimed: -\nresult: -\n\n`;
    const marker = "## Done (archive)";
    const idx = text.indexOf(marker);
    text =
      idx >= 0 ? text.slice(0, idx) + block + text.slice(idx) : `${text.trimEnd()}\n\n${block}`;
    queued += 1;
    log(`queued ${id} [${ev.priority}] ${ev.title}`);
  }
  const tmp = `${TASKS_FILE}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, TASKS_FILE);
  return queued;
}

// --- Main loop -------------------------------------------------------

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const state = loadState();
    const events = [
      ...enforceGovernance(state),
      ...pollLogErrors(state),
      ...pollCronFailures(state),
      ...(await pollGitHub(state)),
    ];
    const queued = queueTasks(events);
    saveState(state);
    if (queued > 0) {
      log(`tick: ${queued} task(s) queued`);
      appendLedger({ kind: "poll", queued, events: events.map((e) => `[${e.source}] ${e.title}`) });
    }
  } catch (e) {
    log(`tick error (non-fatal): ${e.stack || e.message}`);
  } finally {
    ticking = false;
  }
}

log(`event poller started — interval ${INTERVAL_MS}ms, repo ${GITHUB_REPO}@${GITHUB_BRANCH}`);
tick();
setInterval(tick, INTERVAL_MS);
