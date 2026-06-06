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

const DATABASE_URL =
  process.env.SCRATCHPAD_DATABASE_URL || process.env.DATABASE_URL;
const BITDEER_KEY = process.env.BITDEER_API_KEY;
const BASE_URL =
  process.env.BITDEER_BASE_URL || "https://api-inference.bitdeer.ai/v1";
const DEFAULT_MODEL = process.env.WORK_TREE_MODEL || "moonshotai/Kimi-K2.6";
const POLL_MS = Number(process.env.WORK_TREE_POLL_MS || 8000);
// How many node operations (decompose/execute) to perform per tick. Bounded so
// progress streams to the UI and one run can't monopolize the worker.
const STEP_BUDGET = Number(process.env.WORK_TREE_STEP_BUDGET || 6);
// Recursion + size guards so a goal can't expand without bound.
const MAX_DEPTH = Number(process.env.WORK_TREE_MAX_DEPTH || 3);
const MAX_NODES = Number(process.env.WORK_TREE_MAX_NODES || 60);
// A terminal node gets one execute + up to this many correction passes.
const MAX_CORRECTIONS = Number(process.env.WORK_TREE_MAX_CORRECTIONS || 1);
// Max model<->tool round trips per terminal execution attempt (Super Nova
// ReAct loop). Bounds spend and latency so one node can't loop forever.
const MAX_TOOL_STEPS = Number(process.env.SUPER_NOVA_MAX_TOOL_STEPS || 8);
// Global mutual exclusion across daemon instances. Arbitrary stable lock id.
const ADVISORY_LOCK_ID = 778120454;

if (!DATABASE_URL) {
  console.error("work-tree-worker: FATAL — DATABASE_URL missing");
  process.exit(78);
}
// Only require a Bitdeer key when a role actually resolves to the bitdeer
// provider. This lets every role be pointed at OpenAI/OpenRouter/a self-hosted
// endpoint via env without a Bitdeer key, while keeping the default config
// (all roles → bitdeer) fail-fast if the key is missing.
const bitdeerNeeded = ROLES.some((r) => resolveRole(r).providerName === "bitdeer");
if (bitdeerNeeded && !BITDEER_KEY) {
  console.error(
    "work-tree-worker: FATAL — BITDEER_API_KEY missing (a role routes to bitdeer)",
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
      maxTokens: 2000,
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
      const exec = await runTool(String(obj.tool), obj.args || {}, ctx);
      trace.push({
        step: step + 1,
        stage: "execute",
        role,
        tool: String(obj.tool),
        args: obj.args || {},
        ok: !(exec && exec.error),
        result: clip(JSON.stringify(exec), 1200),
      });
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `TOOL RESULT (${obj.tool}):\n${clip(JSON.stringify(exec), 4000)}`,
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
  messages.push({
    role: "user",
    content:
      'Tool budget reached. Output your best final deliverable now as {"final": "..."} — STRICT JSON only.',
  });
  const raw = await chatCompletion({
    messages,
    model: run.model,
    maxTokens: 2000,
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
    "fully satisfies the task's scope and acceptance criteria and contains no " +
    "fabricated or unsupported claims. Output STRICT JSON only: " +
    '{"pass": boolean, "issues": string}. issues: empty when pass=true, else a ' +
    "short, specific list of what must be fixed.";
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
// the UI can show exactly what the node did.
async function runTerminal(run, nodes, node) {
  let issues = "";
  let result = "";
  let verification = "";
  let passed = false;
  let trace = [];
  const role = roleForNode(node);
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
    if (v.pass) break;
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

// Perform up to STEP_BUDGET operations across the run; returns ops performed.
// Super Nova v2: each operation emits a stage event that is merged into the
// run's stage_trace so the UI can show the plan→execute→observe→reflect→critique
// pipeline in real-time.
async function advanceRun(run) {
  let ops = 0;
  const stageLogs = [];
  const ts = () => new Date().toISOString();

  while (ops < STEP_BUDGET) {
    const current = await freshRun(run.id);
    if (!current || current.status !== "running") return ops; // cancelled, etc.

    let nodes = await loadNodes(run.id);

    // Seed the root from the goal on first touch.
    if (!nodes.length) {
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

    // Settle composites whose children are all resolved before picking work.
    await settleComposites(run.id);
    nodes = await loadNodes(run.id);

    // Pick the next actionable node: a pending composite to decompose, or a
    // pending terminal to execute (deepest-first so leaves resolve before
    // parents settle).
    const pendingComposite = nodes
      .filter((n) => n.kind === "composite" && n.status === "pending")
      .sort((a, b) => a.depth - b.depth)[0];
    const pendingTerminal = nodes
      .filter((n) => n.kind === "terminal" && n.status === "pending")
      .sort((a, b) => b.depth - a.depth)[0];

    if (pendingComposite) {
      const t0 = ts();
      await decompose(current, nodes, pendingComposite);
      stageLogs.push({
        stage: "plan",
        role: "planner",
        nodeTitle: clip(pendingComposite.title, 60),
        startedAt: t0,
        completedAt: ts(),
        summary: `Planned "${clip(pendingComposite.title, 60)}"`,
      });
      ops++;
      continue;
    }
    if (pendingTerminal) {
      const role = roleForNode(pendingTerminal);
      const t0 = ts();
      await setNode(pendingTerminal.id, { status: "running" });
      let execOk = true;
      try {
        await runTerminal(current, nodes, pendingTerminal);
      } catch (e) {
        execOk = false;
        await setNode(pendingTerminal.id, {
          status: "failed",
          verification: clip(`error: ${e.message || e}`, 2000),
          attempts: (pendingTerminal.attempts || 0) + 1,
        });
      }
      stageLogs.push({
        stage: "execute",
        role,
        nodeTitle: clip(pendingTerminal.title, 60),
        startedAt: t0,
        completedAt: ts(),
        summary: execOk
          ? `Executed "${clip(pendingTerminal.title, 60)}"`
          : `Failed: ${clip(pendingTerminal.title, 60)}`,
      });
      ops++;
      continue;
    }

    // No pending composite/terminal. Settle once more; if still nothing pending
    // and no running leaves remain, the run is complete.
    await settleComposites(run.id);
    nodes = await loadNodes(run.id);
    const anyPending = nodes.some((n) => n.status === "pending");
    const anyRunningLeaf = nodes.some(
      (n) => n.kind === "terminal" && n.status === "running",
    );
    if (!anyPending && !anyRunningLeaf) {
      // observe: all nodes settled
      const tObs = ts();
      stageLogs.push({
        stage: "observe",
        role: "planner",
        startedAt: tObs,
        completedAt: ts(),
        summary: `${nodes.filter((n) => n.kind === "terminal").length} terminal nodes settled`,
      });
      // reflect: synthesize the final report
      const tRef = ts();
      const report = await synthesizeReport(current, nodes);
      stageLogs.push({
        stage: "reflect",
        role: "planner",
        startedAt: tRef,
        completedAt: ts(),
        summary: clip(report, 120),
      });
      // critique: record final verification verdict
      const anyFailed = nodes.some((n) => n.status === "failed");
      stageLogs.push({
        stage: "critique",
        role: "critic",
        startedAt: ts(),
        completedAt: ts(),
        summary: anyFailed
          ? "Some nodes failed verification"
          : "All nodes verified",
      });
      await persistStageLogs(run.id, stageLogs);
      await setRun(run.id, {
        status: anyFailed ? "failed" : "done",
        report: clip(report, 20000),
        error: anyFailed ? "one or more nodes failed verification" : "",
      });
      console.log(
        `work-tree-worker: run ${run.id} ${anyFailed ? "failed" : "done"} (${nodes.length} nodes)`,
      );
      return ops;
    }
    // Pending exists but we couldn't act (shouldn't happen) — bail this tick.
    // Flush any accumulated stage events so they're visible in the UI.
    if (stageLogs.length) await persistStageLogs(run.id, stageLogs);
    return ops;
  }
  // Budget reached — flush accumulated stage events for this tick.
  if (stageLogs.length) await persistStageLogs(run.id, stageLogs);
  return ops;
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
    // then advance all running runs.
    await claimRun(gov.cap);
    const runs = await runningRuns();
    for (const r of runs) {
      try {
        await advanceRun(r);
      } catch (e) {
        console.error(`work-tree-worker: run ${r.id} error — ${e.message || e}`);
        await setRun(r.id, {
          status: "failed",
          error: clip(String(e.message || e), 1000),
        }).catch(() => {});
      }
    }
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
  `work-tree-worker: ready — model ${DEFAULT_MODEL}, poll ${POLL_MS}ms, ` +
    `budget ${STEP_BUDGET}, maxDepth ${MAX_DEPTH}, maxNodes ${MAX_NODES}`,
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
