#!/usr/bin/env node
// Outcome ledger — append-only structured record of what the agent
// tried and what happened (SOUL.md §17 / §25). Memory of chats is not
// this: the ledger is machine-readable history so the agent can check
// "have I tried this, what happened" before repeating a mistake.
//
// Usage:
//   node ledger.mjs append '{"mission":"...","result":"...","status":"VERIFIED"}'
//   echo '<json>' | node ledger.mjs append
//   node ledger.mjs tail [n]
//   node ledger.mjs grep <substring>
//
// Records are one JSON object per line at /data/workspace/LEDGER.jsonl.
// The poller `ts` field is added automatically. Deterministic, no
// network, append-only — never rewrites or deletes prior records.

import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data";
const LEDGER = path.join(STATE_DIR, "workspace", "LEDGER.jsonl");
const [, , cmd, ...rest] = process.argv;

function appendRecord(rec) {
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
    throw new Error("record must be a JSON object");
  }
  rec.ts = new Date().toISOString();
  fs.appendFileSync(LEDGER, `${JSON.stringify(rec)}\n`);
}

function readLines() {
  try {
    return fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  if (cmd === "append") {
    let raw = rest.join(" ").trim();
    if (!raw) {
      try {
        raw = fs.readFileSync(0, "utf8").trim();
      } catch {
        raw = "";
      }
    }
    if (!raw) {
      process.stderr.write("ledger: no record. Pass JSON as an arg or on stdin.\n");
      process.exit(2);
    }
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`ledger: invalid JSON: ${e.message}\n`);
      process.exit(2);
    }
    try {
      appendRecord(rec);
    } catch (e) {
      process.stderr.write(`ledger: ${e.message}\n`);
      process.exit(2);
    }
    process.stdout.write("ledger: record appended\n");
    return;
  }
  if (cmd === "tail") {
    const n = Math.max(1, Number(rest[0] || 10));
    for (const line of readLines().slice(-n)) process.stdout.write(`${line}\n`);
    return;
  }
  if (cmd === "grep") {
    const needle = rest.join(" ");
    if (!needle) {
      process.stderr.write("ledger: grep needs a substring\n");
      process.exit(2);
    }
    for (const line of readLines()) {
      if (line.includes(needle)) process.stdout.write(`${line}\n`);
    }
    return;
  }
  process.stderr.write(
    "usage: ledger.mjs append '<json>' | ledger.mjs tail [n] | ledger.mjs grep <substring>\n",
  );
  process.exit(2);
}

main();
