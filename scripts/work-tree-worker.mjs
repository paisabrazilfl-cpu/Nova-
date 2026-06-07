#!/usr/bin/env node
// work-tree-worker.mjs — drives the EXHAUSTIVE_RECURSIVE_WORK_TREE methodology.
//
// Flow:
//   1. The api-server queues a run (work_tree_runs, status=pending) from a goal.
//   2. This daemon claims pending runs, seeds a root node from the goal, then on
//      each tick performs a bounded number of node operations:
//        - composite node  -> DECOMPOSE into child subtasks (plan)
//        - terminal node   -> EXECUTE deliverable, then VERIFY, then CORRECT once
//      until every node is terminal (done|failed).
//   3. When the tree is fully resolved it SYNTHESIZES a final report and marks
//      the run done.
//
// "Execution" runs SUPER NOVA's tool-use loop: each terminal node is driven
// through a bounded ReAct loop (scripts/super-nova-tools.mjs) so it can fetch
// URLs, search the web, generate images and — when SUPER_NOVA_EXEC is set —
// run code/shell/file ops, then self-verifies the deliverable. Safe tools are
// always on; dangerous tools are OFF unless SUPER_NOVA_EXEC is set.
//
// Governance: honors GOVERNANCE.json autonomyEnabled as a hard kill switch
// (when false the worker idles). Storage is plain Postgres (DATABASE_URL, or
// SCRATCHPAD_DATABASE_URL to drive the live deployed DB from Replit).

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toolCatalogText,
  runTool,
  toolsEnabledDangerous,
} from "./super-nova-tools.mjs";
import {
  chatComplete,
  resolveRole,
  ROLES,
  routerSummary,
} from "./super-nova-router.mjs";

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOVERNANCE_PATH = path.resolve(__dirname, "..", "GOVERNANCE.json");

// ── Agentic runtime additions ─────────────────────────────────────────────────

// State dir for durable audit log. Matches the env var used by other daemons.
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR ||
  path.resolve(__dirname, "..", ".nova-data");

// Durable audit log — appends JSONL to <STATE_DIR>/audit.jsonl so every run,
// tool call, verification, reflection, and termination is fully traceable.
class AuditLog {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.filePath = filePath;
  }
  write(eventType, payload) {
    try {
      const record =
        JSON.stringify({ ts: new Date().toISOString(), eventType, payload }) +
        "\n";
      fs.appendFileSync(this.filePath, record, "utf-8");
    } catch {
      /* non-fatal — observability must not block execution */
    }
  }
}

// Global audit log (all runs) + per-run factory (one file per run in STATE_DIR).
const globalAudit = new AuditLog(path.join(STATE_DIR, "audit.jsonl"));

function runAudit(runId) {
  const dir = path.join(STATE_DIR, "runs", String(runId));
  fs.mkdirSync(dir, { recursive: true });
  return new AuditLog(path.join(dir, "audit.jsonl"));
}

// ── Risk gates ────────────────────────────────────────────────────────────────
// Each tool is assigned a risk level. HIGH requires SUPER_NOVA_EXEC=1;
// DESTRUCTIVE additionally requires SUPER_NOVA_ALLOW_DESTRUCTIVE=1. This maps
// the spec's RiskLevel enum onto the existing tool catalog.
const TOOL_RISK = {
  // ── Network (SSRF-guarded) ────────────────────────────────────────────────
  http_fetch:            "medium",
  web_fetch:             "medium",
  browser_fetch:         "medium",
  web_search:            "low",
  search_web:            "low",
  google:                "medium",
  x_search:              "medium",
  read_website:          "medium",
  fetch_url:             "medium",   // legacy

  // ── Image / media ─────────────────────────────────────────────────────────
  image_generate:        "medium",
  generate_image:        "medium",
  music_generate:        "medium",
  video_generate:        "medium",
  tts:                   "medium",
  image:                 "medium",
  canvas:                "medium",

  // ── Calculator ────────────────────────────────────────────────────────────
  calculator:            "low",

  // ── Filesystem — read-only (sandbox) ─────────────────────────────────────
  read:                  "low",
  read_file:             "low",
  open_file:             "low",
  list_directory:        "low",
  list_folder:           "low",
  list_dir:              "low",   // legacy
  open_folder:           "low",
  file_exists:           "low",
  search_files:          "low",
  grep_files:            "low",
  diff_render:           "low",
  close_context_item:    "low",

  // ── Git — read-only ───────────────────────────────────────────────────────
  git_status:            "low",
  git_diff:              "low",

  // ── Memory ────────────────────────────────────────────────────────────────
  memory_get:            "low",
  memory_put:            "medium",
  memory_search:         "low",
  vector_search:         "medium",
  search_knowledge:      "low",   // legacy

  // ── Tool catalog ──────────────────────────────────────────────────────────
  tool_search:           "low",
  tool_search_code:      "low",
  tool_describe:         "low",

  // ── MCP ───────────────────────────────────────────────────────────────────
  mcp_list_servers:      "low",
  mcp_list_tools:        "low",
  mcp_call_tool:         "high",

  // ── Control / agents / sessions ───────────────────────────────────────────
  finish:                "low",
  ask_user:              "low",
  update_plan:           "low",
  goal:                  "low",
  steer:                 "low",
  agents_list:           "low",
  agent_send:            "medium",
  subagents:             "medium",
  sessions_list:         "low",
  session_status:        "low",
  sessions_yield:        "low",
  sessions_history:      "medium",
  sessions_send:         "medium",
  sessions_spawn:        "medium",
  heartbeat_respond:     "low",

  // ── Automation ────────────────────────────────────────────────────────────
  cron:                  "high",
  gateway:               "high",
  nodes:                 "high",

  // ── Messaging / productivity ──────────────────────────────────────────────
  message:               "high",
  send_email:            "high",
  draft_email:           "medium",
  calendar_create_event: "high",
  slack_send_message:    "high",

  // ── Filesystem — writes (dangerous) ──────────────────────────────────────
  write:                 "high",
  write_file:            "high",
  edit:                  "high",
  apply_patch:           "high",
  make_directory:        "high",
  create_file:           "high",   // legacy
  move_file:             "high",   // legacy
  patch_file:            "high",   // legacy
  delete_path:           "destructive",
  delete_file:           "destructive",  // legacy

  // ── Code / shell (dangerous) ──────────────────────────────────────────────
  exec:                  "high",
  bash:                  "high",
  shell:                 "high",
  execute_shell:         "high",
  execute_shell_popen:   "high",
  process:               "high",
  code_execution:        "high",
  run_python:            "high",
  execute_python_code:   "high",
  execute_python_file:   "high",
  run_node:              "high",
  run_code:              "high",   // legacy

  // ── Git — write (dangerous) ───────────────────────────────────────────────
  git_commit:            "high",
  clone_repository:      "high",

  // ── DevOps (dangerous) ───────────────────────────────────────────────────
  run_tests:             "high",
  run_build:             "high",
  run_shell:             "destructive",   // legacy
  deploy_service:        "high",
  github_create_issue:   "high",
  github_create_pr:      "high",
  database_query:        "high",

  // ── HTTP mutations (dangerous) ────────────────────────────────────────────
  http_request:          "high",

  // ── Browser (dangerous) ───────────────────────────────────────────────────
  browser:               "high",
  playwright_open:       "high",
  playwright_click:      "high",
  playwright_screenshot: "medium",

  // ── LLM tasks ────────────────────────────────────────────────────────────
  llm_task:              "medium",
  structured_extract:    "medium",
};

function toolRisk(toolName) {
  return TOOL_RISK[String(toolName)] || "low";
}

function isToolAllowed(toolName) {
  const risk = toolRisk(toolName);
  if (risk === "destructive") {
    return process.env.SUPER_NOVA_ALLOW_DESTRUCTIVE === "1";
  }
  if (risk === "high") {
    return toolsEnabledDangerous(); // SUPER_NOVA_EXEC=1
  }
  return true;
}

// ── Acceptance criteria ───────────────────────────────────────────────────────
// Structured criteria stored at run start in the audit log so the post-run
// review can check whether each criterion was met.
function acceptanceCriteria(goal) {
  return [
    "A work tree plan must be created from the user goal.",
    "Every terminal node must be executed through the bounded ReAct tool loop.",
    "Each tool result must be observed and verified by the critic role.",
    "Verification failures must trigger a bounded correction loop (MAX_CORRECTIONS).",
    "A final synthesized report must be produced.",
    "The run must halt when all nodes resolve or the failure/step budget is exceeded.",
    `The final output must address the goal: ${String(goal).slice(0, 200)}`,
  ];
}

// ── Run-level bounded autonomy ────────────────────────────────────────────────
// Hard limits on total node execution attempts and total terminal failures
// across an entire run (not per-node). If either limit is hit we abort
// immediately rather than continuing to spend tokens/time.
const MAX_RUN_STEPS = Number(process.env.WORK_TREE_MAX_RUN_STEPS || 200);
const MAX_RUN_FAILURES = Number(process.env.WORK_TREE_MAX_RUN_FAILURES || 20);

const DATABASE_URL =
  process.env.SCRATCHPAD_DATABASE_URL || process.env.DATABASE_URL;
const BITDEER_KEY = process.env.BITDEER_API_KEY;
const BASE_URL =
  process.env.BITDEER_BASE_URL || "https://api-inference.bitdeer.ai/v1";
const DEFAULT_MODEL = process.env.WORK_TREE_MODEL || "gpt-4o-mini";
const POLL_MS = Number(process.env.WORK_TREE_POLL_MS || 2000);
// How many nodes (decompose + execute) to launch in parallel per tick.
const STEP_BUDGET = Number(process.env.WORK_TREE_STEP_BUDGET || 10);
// Recursion + size guards so a goal can't expand without bound.
const MAX_DEPTH = Number(process.env.WORK_TREE_MAX_DEPTH || 3);
const MAX_NODES = Number(process.env.WORK_TREE_MAX_NODES || 60);
// A terminal node gets one execute + at most this many correction passes.
const MAX_CORRECTIONS = Number(process.env.WORK_TREE_MAX_CORRECTIONS || 1);
// Max model<->tool round trips per terminal execution attempt.
// Bounded so one node can't loop forever.
const MAX_TOOL_STEPS = Number(process.env.SUPER_NOVA_MAX_TOOL_STEPS || 8);
// Global mutual exclusion across daemon instances. Arbitrary stable lock id.
const ADVISORY_LOCK_ID = 778120454;

if (!DATABASE_URL) {
  console.error("work-tree-worker: FATAL — DATABASE_URL missing");
  process.exit(78);
}
// All roles route to OpenAI only (DECOMP-Ω mandate). Verify key is present.
if (!process.env.OPENAI_API_KEY) {
  console.error(
    "work-tree-worker: FATAL — OPENAI_API_KEY missing (Super Nova runs OpenAI only)",
  );
  process.exit(78);
}

const pool = new Pool({ connectionString: DATABASE_URL });

function clip(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) : s;
}

// Build a size-bounded, ALWAYS-VALID-JSON trace string for storage. We cap each
// step's fields and then drop the oldest steps until the serialized form fits
// the column budget — we never slice the serialized JSON itself, since cutting
// mid-structure produces invalid JSON that makes the UI drop the whole trace.
const TRACE_BUDGET = 12000;
function clipArgs(args) {
  if (!args || typeof args !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v;
  }
  return out;
}
function serializeTrace(trace) {
  if (!Array.isArray(trace) || !trace.length) return "";
  let arr = trace.map((t) => ({
    attempt: t.attempt,
    step: t.step,
    stage: t.stage,
    role: t.role,
    tool: t.tool,
    ok: t.ok,
    args: clipArgs(t.args),
    result: clip(String(t.result ?? ""), 1000),
  }));
  let s = JSON.stringify(arr);
  while (s.length > TRACE_BUDGET && arr.length > 1) {
    arr = arr.slice(1);
    s = JSON.stringify(arr);
  }
  if (s.length > TRACE_BUDGET) {
    arr = [{ ...arr[0], result: clip(String(arr[0].result ?? ""), 2000) }];
    s = JSON.stringify(arr);
    if (s.length > TRACE_BUDGET) {
      s = JSON.stringify([{ note: "trace too large to store" }]);
    }
  }
  return s;
}

// GOVERNANCE.json governs autonomous operation (SOUL.md §26). Reads BOTH the
// kill switch (autonomyEnabled) and the daily run cap (dailyAutonomousRunCap).
// Fails CLOSED: an unreadable/corrupt governance file must stop the worker
// rather than let it run unsupervised (autonomyEnabled=false). cap=0 means no
// cap configured; a positive cap limits autonomous runs started per UTC day.
function readGovernance() {
  try {
    const raw = fs.readFileSync(GOVERNANCE_PATH, "utf8");
    const g = JSON.parse(raw);
    const cap = Number(g.dailyAutonomousRunCap ?? 0);
    return {
      autonomyEnabled: g.autonomyEnabled !== false,
      cap: Number.isFinite(cap) && cap > 0 ? cap : 0,
    };
  } catch (e) {
    console.error(
      `work-tree-worker: governance unreadable (${e.message || e}); failing closed`,
    );
    return { autonomyEnabled: false, cap: 0 };
  }
}

// UTC-day key (YYYY-MM-DD) — matches the poller's run-cap reset semantics.
function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

// Durable, restart-safe daily run counter (work_tree_governance). The worker
// holds a global advisory lock while ticking, so the read-then-increment is
// effectively single-writer; the ON CONFLICT upsert keeps it correct even if
// that ever changes.
async function runsStartedToday() {
  const { rows } = await pool.query(
    `SELECT run_count FROM work_tree_governance WHERE day = $1`,
    [utcDay()],
  );
  return rows[0]?.run_count ?? 0;
}

async function incrementRunsToday() {
  await pool.query(
    `INSERT INTO work_tree_governance (day, run_count)
          VALUES ($1, 1)
     ON CONFLICT (day)
     DO UPDATE SET run_count = work_tree_governance.run_count + 1,
                   updated_at = now()`,
    [utcDay()],
  );
}

// All model access goes through the Super Nova v2 router, which resolves the
// logical role (planner/executor/critic/researcher) to a provider+model and
// injects the role's persona. `model` (the run's chosen model) is honored for
// the default bitdeer provider; a role pointed at another provider uses its own
// configured model. See scripts/super-nova-router.mjs.
async function chatCompletion({
  messages,
  maxTokens = 1500,
  temperature = 0.3,
  model,
  role = "planner",
}) {
  return chatComplete({ role, messages, model, maxTokens, temperature });
}

// Single-shot system+user convenience (decompose/verify/synthesize use this).
async function callLLM({
  system,
  user,
  maxTokens = 1500,
  temperature = 0.3,
  model,
  role = "planner",
}) {
  return chatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    maxTokens,
    temperature,
    model,
    role,
  });
}

// Tolerant JSON parse for the agent's ReAct replies. Tries a strict parse of
// the (de-fenced) text first, then falls back to the largest {...} slice.
function parseAgentJson(raw) {
  let text = String(raw || "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const b = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (b !== -1 && e > b) {
    try {
      return JSON.parse(text.slice(b, e + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

function extractJson(raw) {
  let text = String(raw || "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // Try array first (decomposition), then object (verification).
  const a = text.indexOf("[");
  const b = text.indexOf("{");
  let start = -1;
  let end = -1;
  if (a !== -1 && (b === -1 || a < b)) {
    start = a;
    end = text.lastIndexOf("]");
  } else if (b !== -1) {
    start = b;
    end = text.lastIndexOf("}");
  }
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON found");
  }
  return JSON.parse(text.slice(start, end + 1));
}

// ── DB helpers ──────────────────────────────────────────────────────────────

// Claim one pending run, but only if the daily autonomous run cap (if any)
// hasn't been reached. Counts each newly started run in the durable counter so
// the cap survives restarts. In-flight runs already "running" are allowed to
// finish; the cap only gates STARTING new autonomous runs (mirrors the poller,
// which disables future heartbeats rather than killing in-flight ones).
let capLoggedDay = "";
async function claimRun(cap) {
  if (cap > 0) {
    const started = await runsStartedToday();
    if (started >= cap) {
      if (capLoggedDay !== utcDay()) {
        console.log(
          `work-tree-worker: daily autonomous run cap reached (${started}/${cap}); ` +
            `not starting new runs until UTC midnight`,
        );
        capLoggedDay = utcDay();
      }
      return null;
    }
  }
  // Atomically take one pending run and mark it running.
  const { rows } = await pool.query(
    `UPDATE work_tree_runs
        SET status = 'running', updated_at = now()
      WHERE id = (
        SELECT id FROM work_tree_runs
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
  );
  const run = rows[0] || null;
  if (run) await incrementRunsToday();
  return run;
}

async function runningRuns() {
  const { rows } = await pool.query(
    `SELECT * FROM work_tree_runs WHERE status = 'running' ORDER BY created_at ASC`,
  );
  return rows;
}

// Crash recovery (single-instance worker holds the advisory lock). Terminal
// nodes are executed atomically within a tick, so any terminal left "running"
// is orphaned from a killed process — reset it to pending so it re-executes.
async function recoverOrphans() {
  const { rowCount } = await pool.query(
    `UPDATE work_tree_nodes
        SET status = 'pending', updated_at = now()
      WHERE status = 'running' AND kind = 'terminal'`,
  );
  if (rowCount) {
    console.log(`work-tree-worker: recovered ${rowCount} orphaned terminal node(s)`);
  }
}

async function freshRun(id) {
  const { rows } = await pool.query(`SELECT * FROM work_tree_runs WHERE id = $1`, [
    id,
  ]);
  return rows[0] || null;
}

async function loadNodes(runId) {
  const { rows } = await pool.query(
    `SELECT * FROM work_tree_nodes WHERE run_id = $1
      ORDER BY depth ASC, position ASC, id ASC`,
    [runId],
  );
  return rows;
}

async function insertNode(n) {
  const { rows } = await pool.query(
    `INSERT INTO work_tree_nodes
       (run_id, parent_id, title, detail, kind, status, depth, position)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)
     RETURNING *`,
    [n.runId, n.parentId, n.title, n.detail, n.kind, n.depth, n.position],
  );
  return rows[0];
}

async function setNode(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${i++}`);
    vals.push(v);
  }
  sets.push(`updated_at = now()`);
  vals.push(id);
  await pool.query(
    `UPDATE work_tree_nodes SET ${sets.join(", ")} WHERE id = $${i}`,
    vals,
  );
}

async function setRun(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${i++}`);
    vals.push(v);
  }
  sets.push(`updated_at = now()`);
  vals.push(id);
  await pool.query(`UPDATE work_tree_runs SET ${sets.join(", ")} WHERE id = $${i}`, vals);
}

// ── Methodology steps ─────────────────────────────────────────────────────────

function ancestorContext(nodes, node) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain = [];
  let cur = node.parent_id ? byId.get(node.parent_id) : null;
  while (cur) {
    chain.unshift(`- ${cur.title}: ${clip(cur.detail, 300)}`);
    cur = cur.parent_id ? byId.get(cur.parent_id) : null;
  }
  return chain.join("\n");
}

async function decompose(run, nodes, node) {
  const forceTerminal = node.depth + 1 >= MAX_DEPTH;
  const system =
    "You are NOVA's recursive work planner. Break a task into the smallest set " +
    "of concrete, non-overlapping subtasks that together fully accomplish it. " +
    "Output STRICT JSON only: an array of 2-5 objects, each {\"title\": string, " +
    '"detail": string, "kind": "terminal" | "composite"}. ' +
    "title: <=10 words. detail: one sentence of scope + acceptance criteria. " +
    (forceTerminal
      ? 'At this depth every child MUST be "terminal". '
      : 'Use "composite" only when a child still needs further breakdown; prefer "terminal". ') +
    "If the task is already atomic and needs no breakdown, output an empty array [].";
  const user =
    `OVERALL GOAL:\n${clip(run.goal, 2000)}\n\n` +
    (ancestorContext(nodes, node)
      ? `PARENT CONTEXT:\n${ancestorContext(nodes, node)}\n\n`
      : "") +
    `TASK TO DECOMPOSE:\n${node.title}\n${clip(node.detail, 800)}`;

  const raw = await callLLM({
    system,
    user,
    model: run.model,
    maxTokens: 1200,
    temperature: 0.3,
  });
  let children = [];
  try {
    const parsed = extractJson(raw);
    if (Array.isArray(parsed)) children = parsed;
  } catch {
    children = [];
  }

  const total = nodes.length;
  const room = MAX_NODES - total;
  children = children.slice(0, Math.max(0, Math.min(children.length, room)));

  if (!children.length) {
    // Nothing to expand — treat this node as terminal work instead.
    await setNode(node.id, { kind: "terminal", status: "pending" });
    return { expanded: false };
  }

  let pos = 0;
  for (const c of children) {
    const kind = forceTerminal ? "terminal" : c.kind === "composite" ? "composite" : "terminal";
    await insertNode({
      runId: run.id,
      parentId: node.id,
      title: clip(c.title || "Subtask", 300),
      detail: clip(c.detail || "", 1200),
      kind,
      depth: node.depth + 1,
      position: pos++,
    });
  }
  // Composite stays "running" until its children resolve. Record planner role.
  await setNode(node.id, { status: "running", role: "planner" });
  return { expanded: true };
}

// Pick the collaborating role for a terminal node. Information-gathering leaves
// run as the RESEARCHER (source-first framing); everything else as the EXECUTOR.
function roleForNode(node) {
  const t = `${node.title || ""} ${node.detail || ""}`.toLowerCase();
  if (
    /\b(research|investigate|find out|gather|search|look up|sources?|cite|references?|survey|literature|identify|compare|benchmark)\b/.test(
      t,
    )
  ) {
    return "researcher";
  }
  return "executor";
}

// Execute one terminal node as a bounded ReAct tool-use loop. The model either
// calls a tool ({tool,args}) — whose result is fed back — or returns the final
// deliverable ({final}). Returns { result, trace } where trace records every
// tool call made (for the UI). Falls back to plain text if the model never
// emits valid protocol JSON. `role` selects the persona (executor/researcher).
async function executeTerminal(run, nodes, node, priorIssues, role = "executor") {
  const dangerous = toolsEnabledDangerous();
  const catalog = toolCatalogText(dangerous);
  const system =
    "You are SUPER NOVA executing one leaf task of a larger plan. You have REAL " +
    "tools — use them to gather facts, fetch data, run computations, and produce " +
    "the actual finished deliverable for THIS task (the work product itself, not " +
    "a description of how you would do it). Never fabricate a fact you could " +
    "obtain with a tool; if something genuinely cannot be obtained, say so.\n\n" +
    "TOOLS:\n" +
    catalog +
    "\n\n" +
    "PROTOCOL — reply with STRICT JSON only, no prose outside the JSON, exactly " +
    "one object, either:\n" +
    '  {"thought": "<brief>", "tool": "<name>", "args": { ... }}   to call a tool, or\n' +
    '  {"thought": "<brief>", "final": "<the complete finished deliverable as a string>"}   when done.\n' +
    "Use tool results as you go. Emit final as soon as the deliverable is complete.";
  const baseUser =
    `OVERALL GOAL:\n${clip(run.goal, 2000)}\n\n` +
    (ancestorContext(nodes, node)
      ? `WHERE THIS FITS:\n${ancestorContext(nodes, node)}\n\n`
      : "") +
    `TASK:\n${node.title}\n${clip(node.detail, 800)}\n\n` +
    (priorIssues
      ? `A previous attempt was rejected by the verifier for these issues — fix them:\n${clip(priorIssues, 1500)}\n\n`
      : "") +
    "Begin. Use tools as needed, then deliver the completed work.";
  const messages = [
    { role: "system", content: system },
    { role: "user", content: baseUser },
  ];
  const trace = [];
  const ctx = { runId: run.id };

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const raw = await chatCompletion({
      messages,
      model: run.model,
      maxTokens: 4000,
      temperature: 0.4,
      role,
    });
    const obj = parseAgentJson(raw);
    if (!obj) {
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content:
          "Your reply was not valid JSON. Respond with STRICT JSON only per the protocol.",
      });
      continue;
    }
    if (obj.final != null && obj.tool == null) {
      const result =
        typeof obj.final === "string" ? obj.final : JSON.stringify(obj.final);
      return { result, trace };
    }
    if (obj.tool) {
      const toolName = String(obj.tool);
      // Risk gate — block tools whose risk level exceeds current permissions.
      if (!isToolAllowed(toolName)) {
        const risk = toolRisk(toolName);
        globalAudit.write("tool_blocked", {
          runId: run.id,
          nodeId: node.id,
          tool: toolName,
          risk,
          reason:
            risk === "destructive"
              ? "SUPER_NOVA_ALLOW_DESTRUCTIVE not set"
              : "SUPER_NOVA_EXEC not set",
        });
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content:
            `Tool "${toolName}" is blocked (risk: ${risk}). Choose a different ` +
            "approach that does not require this tool.",
        });
        continue;
      }
      // Audit: tool_call
      globalAudit.write("tool_call", {
        runId: run.id,
        nodeId: node.id,
        step: step + 1,
        tool: toolName,
        risk: toolRisk(toolName),
        args: obj.args || {},
      });
      const exec = await runTool(toolName, obj.args || {}, ctx);
      const toolOk = !(exec && exec.error);
      // Audit: tool_result
      globalAudit.write("tool_result", {
        runId: run.id,
        nodeId: node.id,
        step: step + 1,
        tool: toolName,
        ok: toolOk,
        error: exec?.error,
      });
      trace.push({
        step: step + 1,
        stage: "execute",
        role,
        tool: toolName,
        args: obj.args || {},
        ok: toolOk,
        result: clip(JSON.stringify(exec), 1200),
      });
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `TOOL RESULT (${toolName}):\n${clip(JSON.stringify(exec), 4000)}`,
      });
      continue;
    }
    // Neither a tool call nor a final — nudge back onto protocol.
    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content:
        'Respond with either a {"tool", "args"} call or a {"final": "..."} deliverable.',
    });
  }

  // Budget exhausted — force a final answer from what was gathered.
  // Ask for plain markdown so the report isn't trapped inside a JSON string
  // that breaks on token-limit truncation. If the model still wraps in JSON
  // we extract the final value; otherwise raw IS the deliverable.
  messages.push({
    role: "user",
    content:
      "Tool budget reached. Write your complete final deliverable now as plain " +
      "markdown / prose — no JSON wrapper, no {\"final\":...} container, just the " +
      "actual deliverable content. Start writing immediately.",
  });
  const raw = await chatCompletion({
    messages,
    model: run.model,
    maxTokens: 6000,
    temperature: 0.4,
    role,
  });
  const obj = parseAgentJson(raw);
  const result =
    obj && obj.final != null
      ? typeof obj.final === "string"
        ? obj.final
        : JSON.stringify(obj.final)
      : raw;
  return { result, trace };
}

async function verify(run, node, result) {
  const system =
    "You are NOVA's verifier (anti-hallucination gate). Judge whether the work " +
    "product represents a genuine, good-faith attempt at the task and contains no " +
    "fabricated or unsupported claims. Output STRICT JSON only: " +
    '{"pass": boolean, "issues": string}. issues: empty when pass=true, else a ' +
    "short, specific list of what must be fixed.\n\n" +
    "PASS criteria — ALL of these must be true:\n" +
    "  • The work product is non-empty and substantive (not a blank string).\n" +
    "  • No facts are invented or fabricated — the agent only claims what it " +
    "actually observed or retrieved.\n" +
    "  • If external data sources were inaccessible (403, bot-protection, paywalls, " +
    "rate limits), the agent clearly documented what was blocked and why, and " +
    "delivered the best structured analysis possible with available data. " +
    "Honest reporting of access limitations IS a valid deliverable — do not fail " +
    "a node solely because live data was unavailable.\n\n" +
    "FAIL criteria — any of these causes a fail:\n" +
    "  • The work product is empty or contains only boilerplate with no analysis.\n" +
    "  • The agent fabricated specific data points (prices, dates, names) it could " +
    "not have actually retrieved.\n" +
    "  • The task required a specific deliverable format and the agent produced " +
    "something completely different with no explanation.";
  const user =
    `TASK:\n${node.title}\n${clip(node.detail, 800)}\n\n` +
    `WORK PRODUCT:\n${clip(result, 4000)}`;
  const raw = await callLLM({
    system,
    user,
    model: run.model,
    maxTokens: 500,
    temperature: 0,
    role: "critic",
  });
  try {
    const obj = extractJson(raw);
    return { pass: obj.pass === true, issues: clip(obj.issues || "", 1500) };
  } catch {
    // SOUL.md §24: the verifier is a hard gate. An unparseable verdict must NOT
    // pass — treat it as a failure so the bounded correction loop retries, and if
    // it never produces a parseable pass the node is marked failed (not done).
    return {
      pass: false,
      issues:
        "verifier output unparseable — cannot confirm the work; re-state the " +
        "result and respond with STRICT JSON only.",
    };
  }
}

// Run one terminal node through execute -> verify -> correct (bounded). The
// Super Nova tool-use trace from every attempt is accumulated and persisted so
// the UI can show exactly what the node did. Emits structured audit events at
// each phase: task_started, verification, reflection, task_done/task_failed.
async function runTerminal(run, nodes, node) {
  const audit = runAudit(run.id);
  let issues = "";
  let result = "";
  let verification = "";
  let passed = false;
  let trace = [];
  const role = roleForNode(node);

  // Emit: task_started
  const auditPayload = { runId: run.id, nodeId: node.id, title: node.title, role };
  globalAudit.write("task_started", auditPayload);
  audit.write("task_started", auditPayload);

  for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
    const ex = await executeTerminal(run, nodes, node, issues, role);
    result = ex.result;
    if (ex.trace && ex.trace.length) {
      trace = trace.concat(
        ex.trace.map((t) => ({ attempt: attempt + 1, ...t })),
      );
    }
    const v = await verify(run, node, result);
    passed = v.pass;
    verification = v.pass
      ? "verified"
      : `attempt ${attempt + 1} rejected: ${v.issues}`;

    // Emit: verification
    const vPayload = {
      runId: run.id,
      nodeId: node.id,
      attempt: attempt + 1,
      passed: v.pass,
      issues: v.issues,
    };
    globalAudit.write("verification", vPayload);
    audit.write("verification", vPayload);

    if (v.pass) break;

    // Emit: reflection — structured decision on how to handle the failure.
    // decision: "retry" when correction passes remain; "fail_task" when budget
    // is exhausted. Mirrors the spec's Reflection interface.
    const willRetry = attempt < MAX_CORRECTIONS;
    const reflectionPayload = {
      runId: run.id,
      nodeId: node.id,
      taskDescription: node.title,
      toolsUsed: ex.trace ? ex.trace.map((t) => t.tool).filter(Boolean) : [],
      verified: false,
      reason: v.issues,
      decision: willRetry ? "retry" : "fail_task",
      attemptsDone: attempt + 1,
      attemptsRemaining: MAX_CORRECTIONS - attempt,
    };
    globalAudit.write("reflection", reflectionPayload);
    audit.write("reflection", reflectionPayload);

    issues = v.issues;
  }

  await setNode(node.id, {
    status: passed ? "done" : "failed",
    result: clip(result, 8000),
    verification: clip(verification, 2000),
    attempts: (node.attempts || 0) + 1,
    trace: serializeTrace(trace),
    role: roleForNode(node),
  });

  // Emit: task_done / task_failed
  const donePayload = { runId: run.id, nodeId: node.id, passed };
  globalAudit.write(passed ? "task_done" : "task_failed", donePayload);
  audit.write(passed ? "task_done" : "task_failed", donePayload);

  return passed;
}

// Mark composite nodes done once all their children have resolved. Returns true
// if anything changed (so we re-evaluate).
async function settleComposites(runId) {
  let changed = false;
  const nodes = await loadNodes(runId);
  const childrenByParent = new Map();
  for (const n of nodes) {
    if (n.parent_id == null) continue;
    const arr = childrenByParent.get(n.parent_id) || [];
    arr.push(n);
    childrenByParent.set(n.parent_id, arr);
  }
  for (const n of nodes) {
    if (n.kind !== "composite") continue;
    if (n.status === "done" || n.status === "failed") continue;
    const kids = childrenByParent.get(n.id) || [];
    if (!kids.length) continue;
    const allResolved = kids.every(
      (k) => k.status === "done" || k.status === "failed",
    );
    if (allResolved) {
      const anyFailed = kids.some((k) => k.status === "failed");
      await setNode(n.id, { status: anyFailed ? "failed" : "done" });
      changed = true;
    }
  }
  return changed;
}

async function synthesizeReport(run, nodes) {
  const terminals = nodes.filter((n) => n.kind === "terminal");
  const body = terminals
    .map(
      (n) =>
        `### ${n.title} [${n.status}]\n${clip(n.result, 1500) || "(no output)"}`,
    )
    .join("\n\n");
  const system =
    "You are NOVA. Synthesize the completed work tree into a single, coherent " +
    "final report that fulfills the goal. Integrate the leaf deliverables, note " +
    "any parts that failed verification, and end with a brief status line. No " +
    "preamble, no emoji.";
  const user =
    `GOAL:\n${clip(run.goal, 2000)}\n\nLEAF DELIVERABLES:\n${clip(body, 14000)}`;
  try {
    const report = await callLLM({
      system,
      user,
      model: run.model,
      maxTokens: 2500,
      temperature: 0.3,
    });
    if (report.trim()) return report.trim();
  } catch (e) {
    console.error(`work-tree-worker: report synthesis failed — ${e.message || e}`);
  }
  // Deterministic fallback so a run always finishes with something.
  return `# ${run.goal}\n\n${body}`;
}

// Merge new stage events into the run's persisted stage_trace. Loads the
// existing JSON array, appends, caps at 200 entries, and writes back. A warning
// on failure is non-fatal — stage trace is observability metadata, not control
// flow, so a persist error must never abort a run.
async function persistStageLogs(runId, newEvents) {
  if (!newEvents.length) return;
  try {
    const { rows } = await pool.query(
      "SELECT stage_trace FROM work_tree_runs WHERE id = $1",
      [runId],
    );
    let existing = [];
    try {
      existing = JSON.parse(rows[0]?.stage_trace || "[]");
    } catch {}
    if (!Array.isArray(existing)) existing = [];
    const merged = existing.concat(newEvents);
    const capped = merged.length > 200 ? merged.slice(-200) : merged;
    await pool.query(
      "UPDATE work_tree_runs SET stage_trace = $1, updated_at = now() WHERE id = $2",
      [JSON.stringify(capped), runId],
    );
  } catch (e) {
    console.warn(
      `work-tree-worker: stage trace persist failed — ${e.message || e}`,
    );
  }
}

// Advance a run by launching ALL pending nodes in parallel (no sequential queue).
// Composites are decomposed in parallel; terminals are executed in parallel.
// After parallel execution, composites settle, then if the run is complete
// the final report is synthesized. Stage logs are flushed at the end.
async function advanceRun(run) {
  const stageLogs = [];
  const ts = () => new Date().toISOString();

  const current = await freshRun(run.id);
  if (!current || current.status !== "running") return 0;

  let nodes = await loadNodes(run.id);

  // ── Seed root node on first touch ─────────────────────────────────────────
  if (!nodes.length) {
    const startPayload = {
      runId: run.id,
      goal: run.goal,
      acceptanceCriteria: acceptanceCriteria(run.goal),
      maxRunSteps: MAX_RUN_STEPS,
      maxRunFailures: MAX_RUN_FAILURES,
      maxCorrections: MAX_CORRECTIONS,
      maxToolSteps: MAX_TOOL_STEPS,
    };
    globalAudit.write("run_started", startPayload);
    runAudit(run.id).write("run_started", startPayload);
    await insertNode({
      runId: run.id,
      parentId: null,
      title: clip(run.goal, 300),
      detail: "Root goal.",
      kind: "composite",
      depth: 0,
      position: 0,
    });
    nodes = await loadNodes(run.id);
  }

  // ── Bounded autonomy check ─────────────────────────────────────────────────
  const totalAttempts = nodes.reduce((s, n) => s + (n.attempts || 0), 0);
  const totalNodeFailures = nodes.filter(
    (n) => n.kind === "terminal" && n.status === "failed",
  ).length;
  if (totalAttempts >= MAX_RUN_STEPS || totalNodeFailures >= MAX_RUN_FAILURES) {
    const reason =
      totalAttempts >= MAX_RUN_STEPS
        ? `step budget exhausted (${totalAttempts}/${MAX_RUN_STEPS})`
        : `failure budget exhausted (${totalNodeFailures}/${MAX_RUN_FAILURES})`;
    const abortPayload = { runId: run.id, reason, totalAttempts, totalNodeFailures };
    globalAudit.write("run_aborted", abortPayload);
    runAudit(run.id).write("run_aborted", abortPayload);
    await setRun(run.id, { status: "failed", error: `bounded autonomy: ${reason}` });
    console.log(`work-tree-worker: run ${run.id} aborted — ${reason}`);
    return 0;
  }

  // ── Settle composites before picking work ─────────────────────────────────
  await settleComposites(run.id);
  nodes = await loadNodes(run.id);

  // ── Pick all actionable nodes up to STEP_BUDGET ───────────────────────────
  const pendingComposites = nodes
    .filter((n) => n.kind === "composite" && n.status === "pending")
    .sort((a, b) => a.depth - b.depth)
    .slice(0, STEP_BUDGET);

  const terminalSlots = STEP_BUDGET - pendingComposites.length;
  const pendingTerminals = nodes
    .filter((n) => n.kind === "terminal" && n.status === "pending")
    .sort((a, b) => b.depth - a.depth)
    .slice(0, terminalSlots);

  const totalWork = pendingComposites.length + pendingTerminals.length;

  if (totalWork === 0) {
    // Nothing actionable — check if we're done.
    const anyPending = nodes.some((n) => n.status === "pending");
    const anyRunningLeaf = nodes.some(
      (n) => n.kind === "terminal" && n.status === "running",
    );
    if (!anyPending && !anyRunningLeaf && nodes.length > 0) {
      return await finalizeRun(current, nodes, stageLogs, ts);
    }
    if (stageLogs.length) await persistStageLogs(run.id, stageLogs);
    return 0;
  }

  // ── Mark all terminals as running immediately (prevent double-pickup) ──────
  await Promise.all(
    pendingTerminals.map((n) => setNode(n.id, { status: "running" })),
  );

  // ── PARALLEL: decompose all pending composites + execute all pending terminals
  await Promise.all([
    // Decompose all pending composites simultaneously
    ...pendingComposites.map(async (node) => {
      const t0 = ts();
      try {
        await decompose(current, nodes, node);
        stageLogs.push({
          stage: "plan",
          role: "planner",
          nodeTitle: clip(node.title, 60),
          startedAt: t0,
          completedAt: ts(),
          summary: `Planned "${clip(node.title, 60)}"`,
        });
      } catch (e) {
        console.error(`work-tree-worker: decompose node ${node.id} failed — ${e.message || e}`);
        await setNode(node.id, { status: "failed", result: clip(String(e.message || e), 1000) }).catch(() => {});
      }
    }),
    // Execute all pending terminals simultaneously
    ...pendingTerminals.map(async (node) => {
      const role = roleForNode(node);
      const t0 = ts();
      let execOk = true;
      try {
        await runTerminal(current, nodes, node);
      } catch (e) {
        execOk = false;
        await setNode(node.id, {
          status: "failed",
          verification: clip(`error: ${e.message || e}`, 2000),
          attempts: (node.attempts || 0) + 1,
        }).catch(() => {});
      }
      stageLogs.push({
        stage: "execute",
        role,
        nodeTitle: clip(node.title, 60),
        startedAt: t0,
        completedAt: ts(),
        summary: execOk
          ? `Executed "${clip(node.title, 60)}"`
          : `Failed: ${clip(node.title, 60)}`,
      });
    }),
  ]);

  // ── Settle after parallel execution, then check completion ────────────────
  await settleComposites(run.id);
  nodes = await loadNodes(run.id);

  const anyPendingAfter = nodes.some((n) => n.status === "pending");
  const anyRunningLeafAfter = nodes.some(
    (n) => n.kind === "terminal" && n.status === "running",
  );
  if (!anyPendingAfter && !anyRunningLeafAfter && nodes.length > 0) {
    return await finalizeRun(current, nodes, stageLogs, ts);
  }

  if (stageLogs.length) await persistStageLogs(run.id, stageLogs);
  return totalWork;
}

// Synthesize final report, persist status, emit audit event.
async function finalizeRun(run, nodes, stageLogs, ts) {
  const tObs = ts();
  stageLogs.push({
    stage: "observe",
    role: "planner",
    startedAt: tObs,
    completedAt: ts(),
    summary: `${nodes.filter((n) => n.kind === "terminal").length} terminal nodes settled`,
  });
  const tRef = ts();
  const report = await synthesizeReport(run, nodes);
  stageLogs.push({
    stage: "reflect",
    role: "planner",
    startedAt: tRef,
    completedAt: ts(),
    summary: clip(report, 120),
  });
  const anyFailed = nodes.some((n) => n.status === "failed");
  stageLogs.push({
    stage: "critique",
    role: "critic",
    startedAt: ts(),
    completedAt: ts(),
    summary: anyFailed ? "Some nodes failed verification" : "All nodes verified",
  });
  await persistStageLogs(run.id, stageLogs);
  const finalStatus = anyFailed ? "failed" : "done";
  await setRun(run.id, {
    status: finalStatus,
    report: clip(report, 20000),
    error: anyFailed ? "one or more nodes failed verification" : "",
  });
  const finishedPayload = {
    runId: run.id,
    status: finalStatus,
    totalNodes: nodes.length,
    terminalNodes: nodes.filter((n) => n.kind === "terminal").length,
    failedNodes: nodes.filter((n) => n.status === "failed").length,
    totalAttempts: nodes.reduce((s, n) => s + (n.attempts || 0), 0),
  };
  globalAudit.write("run_finished", finishedPayload);
  runAudit(run.id).write("run_finished", finishedPayload);
  console.log(`work-tree-worker: run ${run.id} ${finalStatus} (${nodes.length} nodes)`);
  return nodes.length;
}

let running = false;
let recovered = false;
async function tick() {
  if (running) return;
  running = true;
  const client = await pool.connect();
  let locked = false;
  try {
    const gov = readGovernance();
    if (!gov.autonomyEnabled) return; // kill switch (fails closed)

    const lk = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [
      ADVISORY_LOCK_ID,
    ]);
    locked = lk.rows[0]?.ok === true;
    if (!locked) return;

    // Crash recovery runs once, AFTER we own the global advisory lock — so a
    // second instance starting up can never reset another live worker's nodes.
    if (!recovered) {
      await recoverOrphans();
      recovered = true;
    }

    // Promote one pending run to running per tick (gated by the daily run cap),
    // then advance ALL running runs in parallel (no sequential queue across runs).
    await claimRun(gov.cap);
    const runs = await runningRuns();
    const opsResults = await Promise.all(
      runs.map((r) =>
        advanceRun(r).catch((e) => {
          console.error(`work-tree-worker: run ${r.id} error — ${e.message || e}`);
          return setRun(r.id, {
            status: "failed",
            error: clip(String(e.message || e), 1000),
          }).catch(() => {}).then(() => 0);
        }),
      ),
    );
    // Hot-loop: if any run did real work, fire the next tick immediately
    // (don't wait POLL_MS) so progress is continuous while tasks are active.
    const totalOps = opsResults.reduce((s, n) => s + (n || 0), 0);
    if (totalOps > 0) setImmediate(() => tick());
  } catch (e) {
    console.error("work-tree-worker: tick error", e.message || e);
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID])
        .catch(() => {});
    }
    client.release();
    running = false;
  }
}

console.log(
  `work-tree-worker: ready [DECOMP-Ω / PARALLEL] — model ${DEFAULT_MODEL}, poll ${POLL_MS}ms, ` +
    `budget ${STEP_BUDGET} parallel, maxDepth ${MAX_DEPTH}, maxNodes ${MAX_NODES}, ` +
    `maxCorrections ${MAX_CORRECTIONS}, maxToolSteps ${MAX_TOOL_STEPS}`,
);
console.log(`work-tree-worker: roles — ${routerSummary()}`);
await tick();
const interval = setInterval(() => tick(), POLL_MS);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`work-tree-worker: ${sig} received; shutting down`);
    clearInterval(interval);
    pool.end().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
