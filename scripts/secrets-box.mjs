#!/usr/bin/env node
// OPENCLAWOMEGA — secrets box.
//
// One local, gitignored file (secrets/secrets.env) is the single home
// for every API key and token the system uses. This CLI reads that
// box; it never prints a secret value. Keys go from the box to where
// they are actually consumed (Fly app secrets) without ever being
// hardcoded in source or in a workflow file.
//
// This repo tracks no .gitignore files, so the box's protection
// cannot live in a committed .gitignore. Instead THIS script (which
// is committed) re-establishes the local ignore rule via `init` — run
// it once per machine and the box is hidden everywhere.
//
//   init     create the box + ensure it is gitignored (run first)
//   list     show which keys are set (masked — no values)
//   check    verify the box file is gitignored and untracked
//   export   print `export KEY=...` lines for a shell to eval
//   push     send gateway keys to Fly app secrets (flyctl)
//   help     this text

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOX_REL = "secrets/secrets.env";
const BOX = path.join(REPO, BOX_REL);
const EXAMPLE = path.join(REPO, "secrets/secrets.env.example");
const GITIGNORE = path.join(REPO, ".gitignore");

// Keys that configure deploy tooling, not the running gateway. `push`
// never sends these to the Fly app — FLY_API_TOKEN authenticates
// flyctl itself; OPENCLAW_APP_NAME just names the target app.
const INFRA_ONLY = new Set(["FLY_API_TOKEN", "OPENCLAW_APP_NAME"]);
const DEFAULT_APP = "openclawomega-ace36e";

const IGNORE_MARKER = "Secrets box — real key files";
const IGNORE_BLOCK =
  "\n# Secrets box — real key files never get committed. Only the\n" +
  "# *.example template is tracked. See scripts/secrets-box.mjs.\n" +
  "secrets/*.env\n" +
  "secrets/*.env.local\n" +
  "!secrets/*.example\n" +
  ".secrets.env\n";

function parseEnv(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

function readBox() {
  if (!fs.existsSync(BOX)) {
    console.error(
      `secrets box not found: ${BOX_REL}\n` +
        `Run setup first:\n` +
        `    node scripts/secrets-box.mjs init`,
    );
    process.exit(1);
  }
  return parseEnv(fs.readFileSync(BOX, "utf8"));
}

function templateKeys() {
  try {
    return [...parseEnv(fs.readFileSync(EXAMPLE, "utf8")).keys()];
  } catch {
    return [];
  }
}

function git(args) {
  try {
    return {
      ok: true,
      out: execFileSync("git", args, { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim(),
    };
  } catch (e) {
    return { ok: false, out: (e.stdout || "").toString().trim() };
  }
}

function resolveFlyctl() {
  if (process.env.FLYCTL && fs.existsSync(process.env.FLYCTL)) return process.env.FLYCTL;
  const home = path.join(os.homedir(), ".fly", "bin", "flyctl");
  if (fs.existsSync(home)) return home;
  return "flyctl";
}

function ensureGitignore() {
  let text = "";
  try {
    text = fs.readFileSync(GITIGNORE, "utf8");
  } catch {
    /* no .gitignore yet — will be created */
  }
  if (text.includes(IGNORE_MARKER)) return false;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(GITIGNORE, text + sep + IGNORE_BLOCK);
  return true;
}

function cmdInit() {
  fs.mkdirSync(path.join(REPO, "secrets"), { recursive: true });
  console.log(
    ensureGitignore()
      ? "added secrets-box rules to .gitignore"
      : ".gitignore already protects the box",
  );
  if (!fs.existsSync(BOX)) {
    if (!fs.existsSync(EXAMPLE)) {
      console.error(`template missing: secrets/secrets.env.example`);
      process.exit(1);
    }
    fs.copyFileSync(EXAMPLE, BOX);
    fs.chmodSync(BOX, 0o600);
    console.log(`created ${BOX_REL} from the template — edit it and paste your keys`);
  } else {
    console.log(`${BOX_REL} already exists — left untouched`);
  }
  console.log("");
  cmdCheck();
}

function cmdList() {
  const box = readBox();
  const keys = templateKeys();
  for (const k of box.keys()) if (!keys.includes(k)) keys.push(k);
  console.log(`secrets box: ${BOX_REL}\n`);
  for (const k of keys) {
    const v = box.get(k);
    const status = v ? `set — ${v.length} chars` : "MISSING";
    const tag = INFRA_ONLY.has(k) ? " (infra)" : "";
    console.log(`  ${k.padEnd(22)} ${status}${tag}`);
  }
  console.log(`\nValues are never printed. Use \`check\` to confirm the box is hidden.`);
}

function cmdCheck() {
  if (!fs.existsSync(BOX)) {
    console.log(`box ${BOX_REL} does not exist yet — run \`init\`.`);
    return;
  }
  const ignored = git(["check-ignore", "-q", BOX_REL]).ok;
  const tracked = git(["ls-files", "--error-unmatch", BOX_REL]).ok;
  let bad = false;
  if (tracked) {
    console.error(`EXPOSED: ${BOX_REL} is tracked by git. Remove it now:`);
    console.error(`    git rm --cached ${BOX_REL}`);
    bad = true;
  }
  if (!ignored) {
    console.error(`EXPOSED: ${BOX_REL} is not gitignored. Fix with:`);
    console.error(`    node scripts/secrets-box.mjs init`);
    bad = true;
  }
  if (bad) process.exit(2);
  console.log(`OK: ${BOX_REL} is gitignored and untracked — keys stay local.`);
}

function cmdExport() {
  const box = readBox();
  for (const [k, v] of box) {
    if (!v) continue;
    console.log(`export ${k}='${v.replace(/'/g, "'\\''")}'`);
  }
}

function cmdPush() {
  const box = readBox();
  const app = box.get("OPENCLAW_APP_NAME") || process.env.OPENCLAW_APP_NAME || DEFAULT_APP;
  const payload = [];
  for (const [k, v] of box) {
    if (INFRA_ONLY.has(k) || !v) continue;
    payload.push(`${k}=${v}`);
  }
  if (payload.length === 0) {
    console.error("no gateway keys set in the box — nothing to push.");
    process.exit(1);
  }
  const token = box.get("FLY_API_TOKEN") || process.env.FLY_API_TOKEN || "";
  if (!token) {
    console.error("FLY_API_TOKEN is not set (box or env) — flyctl cannot authenticate.");
    process.exit(1);
  }
  const flyctl = resolveFlyctl();
  console.log(`pushing ${payload.length} key(s) to Fly app "${app}" via ${flyctl}...`);
  try {
    execFileSync(flyctl, ["secrets", "import", "-a", app], {
      input: `${payload.join("\n")}\n`,
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, FLY_API_TOKEN: token },
    });
    console.log(`done — ${payload.length} secret(s) applied to ${app}.`);
  } catch {
    console.error("flyctl secrets import failed — see output above.");
    process.exit(1);
  }
}

const HELP = `secrets-box — local vault for OPENCLAWOMEGA API keys

  node scripts/secrets-box.mjs <command>

  init     create the box and ensure it is gitignored (run first)
  list     show which keys are set (masked, no values)
  check    verify ${BOX_REL} is gitignored and untracked
  export   print \`export KEY=...\` lines  (eval "$(... export)")
  push     send gateway keys from the box to Fly app secrets
  help     this text

The box file ${BOX_REL} is the one local home for every key. It is
gitignored and never committed; only secrets.env.example is tracked.`;

const cmd = process.argv[2] || "list";
(
  ({
    init: cmdInit,
    list: cmdList,
    check: cmdCheck,
    export: cmdExport,
    push: cmdPush,
    help: () => console.log(HELP),
  })[cmd] ||
  (() => {
    console.error(`unknown command: ${cmd}\n`);
    console.error(HELP);
    process.exit(1);
  })
)();
