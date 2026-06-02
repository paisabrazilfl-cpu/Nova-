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
// "Execution" here is LLM reasoning only — it produces each terminal node's
// deliverable as text and self-verifies it. It runs no shell/code/repo actions.
//
// Governance: honors GOVERNANCE.json autonomyEnabled as a hard kill switch
// (when false the worker idles). Storage is plain Postgres (DATABASE_URL, or
// SCRATCHPAD_DATABASE_URL to drive the live deployed DB from Replit).

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
// Global mutual exclusion across daemon instances. Arbitrary stable lock id.
const ADVISORY_LOCK_ID = 778120454;

if (!DATABASE_URL) {
  console.error("work-tree-worker: FATAL — DATABASE_URL missing");
  process.exit(78);
}
if (!BITDEER_KEY) {
  console.error("work-tree-worker: FATAL — BITDEER_API_KEY missing");
  process.exit(78);
}

const pool = new Pool({ connectionString: DATABASE_URL });

function clip(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) : s;
}

// GOVERNANCE.json kill switch (SOUL.md §26) — when autonomyEnabled is false the
// worker idles. Fails CLOSED: an unreadable/corrupt governance file must stop the
// worker rather than let it run unsupervised.
function autonomyEnabled() {
  try {
    const raw = fs.readFileSync(GOVERNANCE_PATH, "utf8");
    const g = JSON.parse(raw);
    return g.autonomyEnabled !== false;
  } catch (e) {
    console.error(
      `work-tree-worker: governance unreadable (${e.message || e}); failing closed`,
    );
    return false;
  }
}

async function callLLM({ system, user, maxTokens = 1500, temperature = 0.3, model }) {
  const body = {
    model: model || DEFAULT_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BITDEER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const j = await res.json();
    return j.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
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

async function claimRun() {
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
  return rows[0] || null;
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
  // Composite stays "running" until its children resolve.
  await setNode(node.id, { status: "running" });
  return { expanded: true };
}

async function executeTerminal(run, nodes, node, priorIssues) {
  const system =
    "You are NOVA executing one leaf task of a larger plan. Produce the actual " +
    "deliverable for THIS task — the finished work product, not a description of " +
    "how you would do it. Be concrete, correct, and self-contained. If the task " +
    "is open-ended, make and state reasonable assumptions. Do not fabricate " +
    "facts; if something cannot be known, say so explicitly.";
  const user =
    `OVERALL GOAL:\n${clip(run.goal, 2000)}\n\n` +
    (ancestorContext(nodes, node)
      ? `WHERE THIS FITS:\n${ancestorContext(nodes, node)}\n\n`
      : "") +
    `TASK:\n${node.title}\n${clip(node.detail, 800)}\n\n` +
    (priorIssues
      ? `A previous attempt was rejected by the verifier for these issues — fix them:\n${clip(priorIssues, 1500)}\n\n`
      : "") +
    "Deliver the completed work now.";
  return callLLM({
    system,
    user,
    model: run.model,
    maxTokens: 2000,
    temperature: 0.4,
  });
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

// Run one terminal node through execute -> verify -> correct (bounded).
async function runTerminal(run, nodes, node) {
  let issues = "";
  let result = "";
  let verification = "";
  let passed = false;
  for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
    result = await executeTerminal(run, nodes, node, issues);
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

// Perform up to STEP_BUDGET operations across the run; returns ops performed.
async function advanceRun(run) {
  let ops = 0;
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
      await decompose(current, nodes, pendingComposite);
      ops++;
      continue;
    }
    if (pendingTerminal) {
      await setNode(pendingTerminal.id, { status: "running" });
      try {
        await runTerminal(current, nodes, pendingTerminal);
      } catch (e) {
        await setNode(pendingTerminal.id, {
          status: "failed",
          verification: clip(`error: ${e.message || e}`, 2000),
          attempts: (pendingTerminal.attempts || 0) + 1,
        });
      }
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
      const report = await synthesizeReport(current, nodes);
      const anyFailed = nodes.some((n) => n.status === "failed");
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
    return ops;
  }
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
    if (!autonomyEnabled()) return; // kill switch

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

    // Promote one pending run to running per tick, then advance all running runs.
    await claimRun();
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
