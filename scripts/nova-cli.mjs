#!/usr/bin/env node
// nova-cli — operator + agent CLI for the NOVA runtime.
// Installed in the image as /usr/local/bin/nova.
//
// Subcommands
//   nova deep submit <prompt>        — enqueue a deep-worker job, prints job id
//   nova deep wait   <id> [--timeout 600]
//                                    — block until job is done/failed, print result
//   nova deep poll   <id>            — print result if ready, exit 1 if not yet
//   nova jobs ls                     — list pending / running / done / failed
//   nova jobs clear  done|failed|all — wipe finished job artifacts
//   nova logs        deep|poll|gateway [--lines N]
//                                    — tail a daemon log
//   nova chat "<text>"               — POST to the gateway /v1/chat/completions
//                                       (uses OPENCLAW_GATEWAY_TOKEN from env)
//   nova ws ls                       — list workspace dirs on /data (server-side
//                                       workspace dirs only; the browser-side
//                                       IndexedDB workspaces are not visible here)
//   nova status                      — quick health snapshot
//   nova help                        — this text

import { readFile, writeFile, readdir, rename, unlink, mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomBytes } from "node:crypto";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data";
const JOBS_ROOT = path.join(STATE_DIR, "jobs");
const PENDING_DIR = path.join(JOBS_ROOT, "pending");
const RUNNING_DIR = path.join(JOBS_ROOT, "running");
const DONE_DIR = path.join(JOBS_ROOT, "done");
const FAILED_DIR = path.join(JOBS_ROOT, "failed");

const LOG_PATHS = {
  deep: "/tmp/deep-worker.log",
  poll: "/tmp/poll-events.log",
  gateway: "/tmp/openclaw/openclaw-" + new Date().toISOString().slice(0, 10) + ".log"
};

function die(msg, code = 1) { console.error(`nova: ${msg}`); process.exit(code); }
function genId() { return new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(4).toString("hex"); }

async function ensureDirs() {
  for (const d of [PENDING_DIR, RUNNING_DIR, DONE_DIR, FAILED_DIR]) await mkdir(d, { recursive: true });
}

async function readJson(p) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } }

async function deepSubmit(args) {
  const prompt = args.join(" ").trim();
  if (!prompt) die("usage: nova deep submit <prompt>");
  await ensureDirs();
  const id = genId();
  const job = { id, prompt, submittedAt: Date.now() };
  await writeFile(path.join(PENDING_DIR, `${id}.json`), JSON.stringify(job, null, 2));
  console.log(id);
}

async function deepPoll(args) {
  const id = args[0];
  if (!id) die("usage: nova deep poll <id>");
  const done = await readJson(path.join(DONE_DIR, `${id}.json`));
  if (done) { console.log(done.result || ""); return; }
  const failed = await readJson(path.join(FAILED_DIR, `${id}.json`));
  if (failed) die(`job ${id} failed: ${failed.error}`, 2);
  console.error(`nova: job ${id} not done yet`);
  process.exit(1);
}

async function deepWait(args) {
  const id = args[0];
  if (!id) die("usage: nova deep wait <id> [--timeout SEC]");
  const tIdx = args.indexOf("--timeout");
  const timeoutSec = tIdx >= 0 ? Number(args[tIdx + 1] || 600) : 600;
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const done = await readJson(path.join(DONE_DIR, `${id}.json`));
    if (done) { console.log(done.result || ""); return; }
    const failed = await readJson(path.join(FAILED_DIR, `${id}.json`));
    if (failed) die(`job ${id} failed: ${failed.error}`, 2);
    await new Promise(r => setTimeout(r, 2000));
  }
  die(`job ${id} did not finish within ${timeoutSec}s`, 3);
}

async function jobsLs() {
  await ensureDirs();
  for (const [label, dir] of [["pending", PENDING_DIR], ["running", RUNNING_DIR], ["done", DONE_DIR], ["failed", FAILED_DIR]]) {
    const names = (await readdir(dir).catch(() => [])).filter(n => n.endsWith(".json"));
    console.log(`${label}: ${names.length}`);
    for (const n of names) console.log(`  ${n.replace(/\.json$/, "")}`);
  }
}

async function jobsClear(args) {
  const which = args[0];
  if (!["done", "failed", "all"].includes(which)) die("usage: nova jobs clear done|failed|all");
  const dirs = which === "all" ? [DONE_DIR, FAILED_DIR] : [which === "done" ? DONE_DIR : FAILED_DIR];
  let n = 0;
  for (const dir of dirs) {
    for (const name of await readdir(dir).catch(() => [])) {
      await unlink(path.join(dir, name)).catch(() => {});
      n++;
    }
  }
  console.log(`cleared ${n} file(s)`);
}

async function logsTail(args) {
  const which = args[0];
  if (!LOG_PATHS[which]) die("usage: nova logs deep|poll|gateway [--lines N]");
  const lIdx = args.indexOf("--lines");
  const lines = lIdx >= 0 ? args[lIdx + 1] : "80";
  const p = spawn("tail", ["-n", String(lines), LOG_PATHS[which]], { stdio: "inherit" });
  p.on("exit", code => process.exit(code || 0));
}

async function chat(args) {
  const text = args.join(" ").trim();
  if (!text) die("usage: nova chat \"<message>\"");
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) die("OPENCLAW_GATEWAY_TOKEN not set in env");
  const apiKey = process.env.BITDEER_API_KEY;
  const useDirect = !!apiKey;
  const url = useDirect
    ? "https://api-inference.bitdeer.ai/v1/chat/completions"
    : "http://127.0.0.1:3000/v1/chat/completions";
  const auth = useDirect ? `Bearer ${apiKey}` : `Bearer ${token}`;
  const body = {
    model: useDirect ? "openai/gpt-oss-20b" : "bitdeer/mistralai/Mistral-Large-3-675B-Instruct-2512",
    messages: [
      { role: "system", content: "You are NOVA. Reply tersely." },
      { role: "user", content: text }
    ],
    max_tokens: 2048, temperature: 0.1, stream: false
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": auth, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) die(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`, 4);
  const j = await res.json();
  console.log(j.choices?.[0]?.message?.content || "");
}

async function wsLs() {
  // Server-side workspace dirs (none exist by default since the UI uses
  // browser IndexedDB). Useful only if the operator manually placed files.
  const root = path.join(STATE_DIR, "workspaces");
  try {
    const dirs = await readdir(root);
    for (const d of dirs) {
      const files = await readdir(path.join(root, d)).catch(() => []);
      console.log(`${d}: ${files.length} file(s)`);
      for (const f of files) console.log(`  ${f}`);
    }
  } catch {
    console.log("(no server-side workspace dir; UI workspaces are stored in browser IndexedDB)");
  }
}

async function status() {
  await ensureDirs();
  const counts = {};
  for (const [k, dir] of [["pending", PENDING_DIR], ["running", RUNNING_DIR], ["done", DONE_DIR], ["failed", FAILED_DIR]]) {
    counts[k] = (await readdir(dir).catch(() => [])).filter(n => n.endsWith(".json")).length;
  }
  console.log("jobs:", JSON.stringify(counts));
  // Gateway health
  try {
    const r = await fetch("http://127.0.0.1:3000/health", { signal: AbortSignal.timeout(3000) });
    console.log("gateway:", r.ok ? (await r.text()).trim() : `HTTP ${r.status}`);
  } catch (e) { console.log("gateway: unreachable"); }
  // Deep worker log existence
  try {
    const s = await stat(LOG_PATHS.deep);
    console.log(`deep-worker.log: ${s.size}b, mtime ${s.mtime.toISOString()}`);
  } catch { console.log("deep-worker.log: missing"); }
}

function help() {
  console.log(`nova — NOVA runtime CLI

Subcommands:
  deep submit <prompt>          enqueue a deep-worker job (prints id)
  deep wait <id> [--timeout S]  block until result is ready, print it
  deep poll <id>                print result if ready, exit 1 if not
  jobs ls                       list pending/running/done/failed
  jobs clear done|failed|all    wipe finished job artifacts
  logs deep|poll|gateway [--lines N]
                                tail a daemon log (default 80 lines)
  chat "<text>"                 quick one-shot inference (direct Bitdeer
                                if BITDEER_API_KEY present, else gateway)
  ws ls                         list server-side workspace dirs (UI
                                workspaces live in browser IndexedDB)
  status                        health snapshot
  help                          this text
`);
}

const [, , cmd, sub, ...rest] = process.argv;
const args = sub !== undefined ? [sub, ...rest] : [];

(async () => {
  switch (cmd) {
    case "deep":
      switch (sub) {
        case "submit": return deepSubmit(rest);
        case "wait":   return deepWait(rest);
        case "poll":   return deepPoll(rest);
        default: die(`unknown: nova deep ${sub || ""}`);
      }
    case "jobs":
      switch (sub) {
        case "ls":    return jobsLs();
        case "clear": return jobsClear(rest);
        default: die(`unknown: nova jobs ${sub || ""}`);
      }
    case "logs":   return logsTail(args);
    case "chat":   return chat([sub, ...rest].filter(Boolean));
    case "ws":
      switch (sub) {
        case "ls": return wsLs();
        default: die(`unknown: nova ws ${sub || ""}`);
      }
    case "status": return status();
    case "help": case "-h": case "--help": case undefined: return help();
    default: die(`unknown command: ${cmd}\nrun \`nova help\` for usage`);
  }
})().catch(e => die(e.message || String(e)));
