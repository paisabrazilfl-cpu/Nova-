// super-nova-tools.mjs — the tool registry for SUPER NOVA, the Work Tree's
// tool-using agent loop. Terminal nodes call these tools through a bounded ReAct
// loop (see work-tree-worker.mjs) to do real work instead of LLM text only.
//
// Two tiers:
//   SAFE      — always available, no new secrets, low blast radius:
//               http_fetch (SSRF-guarded), browser_fetch (Steel.dev — bypasses
//               bot-protection / JS-rendered pages), web_search (Firecrawl →
//               Brave fallback), image_generate (Bitdeer).
//   DANGEROUS — code/shell/file execution. OFF by default. Only offered to the
//               model when SUPER_NOVA_EXEC is set, because the Work Tree HTTP
//               endpoint is unauthenticated and these tools run on the host.
//
// Everything runs inside a per-run sandbox dir under the OS temp dir. http_fetch
// blocks private/internal/metadata addresses and does not follow redirects
// (it surfaces the Location so the model must re-fetch through the guard).

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import dns from "node:dns/promises";
import { lookup as rawLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";

const BITDEER_KEY = process.env.BITDEER_API_KEY;
const BASE_URL =
  process.env.BITDEER_BASE_URL || "https://api-inference.bitdeer.ai/v1";

const EXEC_TIMEOUT_MS = Number(process.env.SUPER_NOVA_EXEC_TIMEOUT_MS || 30000);
const FETCH_TIMEOUT_MS = Number(process.env.SUPER_NOVA_FETCH_TIMEOUT_MS || 20000);
const MAX_OUTPUT = 6000;
const MAX_BODY = 8000;

// ── SSRF guard ───────────────────────────────────────────────────────────────

function ipIsPrivate(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local + cloud metadata
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true;
  if (s.startsWith("fc") || s.startsWith("fd")) return true; // unique-local fc00::/7
  if (s.startsWith("fe80")) return true; // link-local
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return ipIsPrivate(m[1]);
  return false;
}

async function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http/https URLs are allowed");
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("blocked internal host");
  }
  if (net.isIP(host) && ipIsPrivate(host)) {
    throw new Error("blocked private address");
  }
  let addrs = [];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error("DNS resolution failed");
  }
  for (const a of addrs) {
    if (ipIsPrivate(a.address)) throw new Error("blocked private address");
  }
  return u;
}

// Connect-time DNS guard. net.connect() calls this `lookup` at socket-connect
// time, so the address we validate here is the exact address we connect to —
// closing the DNS-rebinding / TOCTOU window between assertSafeUrl()'s pre-check
// and the actual connection. We always inspect every resolved address and only
// hand back the safe ones.
function guardedLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  rawLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses)
      ? addresses
      : [{ address: addresses, family: options && options.family === 6 ? 6 : 4 }];
    const safe = list.filter((a) => !ipIsPrivate(a.address));
    if (!safe.length) return callback(new Error("blocked private address"));
    if (options && options.all) return callback(null, safe);
    return callback(null, safe[0].address, safe[0].family);
  });
}

// Low-level fetch built on node:http(s) so we can (a) pin the connect-time DNS
// resolution through guardedLookup and (b) stream-cap the response body instead
// of buffering an unbounded amount into memory. Redirects are NOT followed —
// each hop must be re-fetched so the SSRF guard re-validates it.
function rawFetch({ url, method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error("invalid URL"));
      return;
    }
    const mod = u.protocol === "https:" ? https : http;
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const fail = (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };
    const req = mod.request(
      u,
      { method, headers: headers || {}, lookup: guardedLookup },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          done({
            status,
            redirectTo: res.headers.location || "",
            note: "redirect not followed — re-fetch the redirect URL to keep the SSRF guard in effect",
          });
          return;
        }
        const contentType = res.headers["content-type"] || "";
        const chunks = [];
        let received = 0;
        let truncated = false;
        res.on("data", (d) => {
          if (truncated) return;
          received += d.length;
          chunks.push(d);
          if (received >= MAX_BODY) {
            truncated = true;
            req.destroy();
            done({
              status,
              contentType,
              body: Buffer.concat(chunks).toString("utf8").slice(0, MAX_BODY),
              truncated: true,
            });
          }
        });
        res.on("end", () =>
          done({
            status,
            contentType,
            body: Buffer.concat(chunks).toString("utf8").slice(0, MAX_BODY),
            truncated,
          }),
        );
        res.on("error", fail);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout")));
    req.on("error", fail);
    if (body != null && method !== "GET" && method !== "HEAD") req.write(String(body));
    req.end();
  });
}

// ── Sandbox ──────────────────────────────────────────────────────────────────

async function sandboxDir(runId) {
  const dir = path.join(os.tmpdir(), "super-nova", String(runId ?? "misc"));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function resolveInSandbox(dir, p) {
  const resolved = path.resolve(dir, p);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error("path escapes the sandbox");
  }
  return resolved;
}

function execProcess(cmd, argv, { cwd, timeoutMs = EXEC_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, { cwd });
    } catch (e) {
      resolve({ error: `spawn failed: ${e.message || e}` });
      return;
    }
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (out.length < MAX_OUTPUT) out += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (err.length < MAX_OUTPUT) err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ error: `spawn failed: ${e.message || e}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: out.slice(0, MAX_OUTPUT),
        stderr: err.slice(0, MAX_OUTPUT),
        timedOut,
      });
    });
  });
}

// ── SAFE tools ───────────────────────────────────────────────────────────────

async function httpFetch(args) {
  const url = String(args.url || "");
  if (!url) return { error: "url required" };
  const method = String(args.method || "GET").toUpperCase();
  // Fast literal/pre-resolution pre-check (defense in depth); the authoritative
  // guard is guardedLookup, applied at connect time inside rawFetch.
  await assertSafeUrl(url);
  const headers =
    args.headers && typeof args.headers === "object" ? args.headers : {};
  return rawFetch({
    url,
    method,
    headers,
    body: args.body,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
}

async function webSearch(args) {
  const q = String(args.query || "").slice(0, 400);
  if (!q) return { error: "query required" };
  // Try each configured provider in precedence order. A provider failure (bad
  // key → 401, rate limit, network error, or empty result) falls through to the
  // next provider instead of aborting, so one stale key can't disable search.
  // Firecrawl is primary; Brave is the fallback.  Tavily is not used.
  const providers = [
    { key: "FIRECRAWL_API_KEY", run: searchFirecrawl },
    { key: "BRAVE_API_KEY", run: searchBrave },
  ];
  const configured = providers.filter((p) => process.env[p.key]);
  if (!configured.length) {
    return {
      error:
        "web_search unavailable: no search provider key set " +
        "(FIRECRAWL_API_KEY / BRAVE_API_KEY). " +
        "Use http_fetch or browser_fetch on a known URL instead.",
    };
  }
  const errors = [];
  for (const p of configured) {
    try {
      const out = await p.run(q);
      if (out && out.results && out.results.length) return out;
      errors.push(`${out && out.provider ? out.provider : p.key}: no results`);
    } catch (e) {
      errors.push(`${p.key.replace("_API_KEY", "").toLowerCase()}: ${e.message || e}`);
    }
  }
  return { error: `all search providers failed (${errors.join("; ")})` };
}

async function searchBrave(q) {
  const res = await fetch(
    "https://api.search.brave.com/res/v1/web/search?count=5&q=" + encodeURIComponent(q),
    { headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY, Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`brave ${res.status}`);
  const j = await res.json();
  return {
    provider: "brave",
    results: ((j.web && j.web.results) || []).slice(0, 5).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: String(r.description || "").slice(0, 300),
    })),
  };
}

async function searchFirecrawl(q) {
  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: q, limit: 5 }),
  });
  if (!res.ok) throw new Error(`firecrawl ${res.status}`);
  const j = await res.json();
  // v1 returns {data:[...]}, v2 returns {data:{web:[...]}} — handle both.
  const rows = Array.isArray(j.data) ? j.data : (j.data && j.data.web) || [];
  return {
    provider: "firecrawl",
    results: rows.slice(0, 5).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: String(r.description || r.snippet || "").slice(0, 300),
    })),
  };
}

// ── Steel.dev browser fetch ───────────────────────────────────────────────────
// Uses a real headless browser via Steel.dev to fetch pages that block direct
// HTTP (403, Cloudflare, JS-rendered content).  Falls back gracefully when the
// key is absent so local/dev runs without Steel still work.

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function browserFetch(args) {
  const url = String(args.url || "").trim();
  if (!url) return { error: "url required" };
  if (!process.env.STEEL_API_KEY)
    return { error: "browser_fetch unavailable: STEEL_API_KEY not set" };
  const res = await fetch("https://api.steel.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Steel-Api-Key": process.env.STEEL_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, useProxy: true }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`steel ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  // Steel returns {content:{html,markdown?}, metadata, links}
  const text = (j.content && j.content.markdown)
    ? j.content.markdown
    : stripHtml((j.content && j.content.html) || "");
  return {
    url,
    body: text.slice(0, 8000),
    truncated: text.length > 8000,
    links: (j.links || []).slice(0, 20).map((l) =>
      typeof l === "string" ? l : l.href || l.url || ""
    ),
  };
}

async function imageGenerate(args, ctx) {
  const prompt = String(args.prompt || "").slice(0, 1000);
  if (!prompt) return { error: "prompt required" };
  if (!BITDEER_KEY) return { error: "image_generate unavailable: BITDEER_API_KEY not set" };
  const res = await fetch(`${BASE_URL}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BITDEER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.SUPER_NOVA_IMAGE_MODEL || "google/imagen-4.0-ultra",
      prompt,
      n: 1,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { error: `image API ${res.status}: ${t.slice(0, 200)}` };
  }
  const j = await res.json();
  const b64 = j.data?.[0]?.b64_json;
  const remoteUrl = j.data?.[0]?.url;
  if (b64) {
    const dir = await sandboxDir(ctx.runId);
    const file = path.join(dir, `image-${Date.now()}.jpg`);
    await fs.writeFile(file, Buffer.from(b64, "base64"));
    return { saved: file, bytes: Buffer.byteLength(b64, "base64") };
  }
  if (remoteUrl) return { url: remoteUrl };
  return { error: "no image returned" };
}

// ── DANGEROUS tools (gated) ──────────────────────────────────────────────────

async function runPython(args, ctx) {
  const code = String(args.code || "");
  if (!code) return { error: "code required" };
  const dir = await sandboxDir(ctx.runId);
  const file = path.join(dir, `script-${Date.now()}.py`);
  await fs.writeFile(file, code);
  return execProcess("python3", [file], { cwd: dir });
}

async function runNode(args, ctx) {
  const code = String(args.code || "");
  if (!code) return { error: "code required" };
  const dir = await sandboxDir(ctx.runId);
  const file = path.join(dir, `script-${Date.now()}.mjs`);
  await fs.writeFile(file, code);
  return execProcess("node", [file], { cwd: dir });
}

async function shellExec(args, ctx) {
  const command = String(args.command || "");
  if (!command) return { error: "command required" };
  const dir = await sandboxDir(ctx.runId);
  return execProcess("bash", ["-lc", command], { cwd: dir });
}

async function writeFile(args, ctx) {
  const rel = String(args.path || "");
  if (!rel) return { error: "path required" };
  const dir = await sandboxDir(ctx.runId);
  const file = resolveInSandbox(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const content = String(args.content ?? "");
  await fs.writeFile(file, content);
  return { saved: file, bytes: Buffer.byteLength(content) };
}

async function readFile(args, ctx) {
  const rel = String(args.path || "");
  if (!rel) return { error: "path required" };
  const dir = await sandboxDir(ctx.runId);
  const file = resolveInSandbox(dir, rel);
  const data = await fs.readFile(file, "utf8");
  return { content: data.slice(0, MAX_BODY), truncated: data.length > MAX_BODY };
}

// ── Registry ─────────────────────────────────────────────────────────────────

const SAFE_TOOLS = {
  http_fetch: {
    run: httpFetch,
    desc: 'fetch an http/https URL. args: {url, method?, headers?, body?}. Private/internal/metadata addresses are blocked; redirects are not auto-followed. Returns {status, contentType, body (truncated)}. Use this for plain HTTP APIs and public endpoints. If the site blocks bots (403, Cloudflare, JS-rendered), use browser_fetch instead.',
  },
  browser_fetch: {
    run: browserFetch,
    desc: 'fetch a URL using a real headless browser (Steel.dev). args: {url}. Bypasses bot-protection, Cloudflare, and JS-rendered pages that block http_fetch. Returns {body (text, up to 8000 chars), links}. Use this when http_fetch returns 403 or empty content on a real website.',
  },
  web_search: {
    run: webSearch,
    desc: 'search the web via Firecrawl (primary) or Brave (fallback). args: {query}. Returns ranked results with title, url, snippet. Use this to discover URLs, then fetch them with http_fetch or browser_fetch.',
  },
  image_generate: {
    run: imageGenerate,
    desc: 'generate an image from a text prompt (Bitdeer). args: {prompt}. Saves a file and returns its path.',
  },
};

const DANGEROUS_TOOLS = {
  run_python: {
    run: runPython,
    desc: 'run Python 3 code in an isolated per-run sandbox dir. args: {code}. ' +
      EXEC_TIMEOUT_MS / 1000 +
      's timeout. Returns {exitCode, stdout, stderr, timedOut}.',
  },
  run_node: {
    run: runNode,
    desc: 'run Node.js (ESM) code in the sandbox dir. args: {code}. Returns {exitCode, stdout, stderr, timedOut}.',
  },
  shell: {
    run: shellExec,
    desc: 'run a bash command in the sandbox dir. args: {command}. Returns {exitCode, stdout, stderr, timedOut}.',
  },
  write_file: {
    run: writeFile,
    desc: 'write a file inside the run sandbox. args: {path, content}.',
  },
  read_file: {
    run: readFile,
    desc: 'read a file inside the run sandbox. args: {path}.',
  },
};

// Dangerous tools are only offered/runnable when SUPER_NOVA_EXEC is set to a
// truthy value. This is the kill switch that keeps code/shell execution off the
// unauthenticated Work Tree endpoint by default.
export function toolsEnabledDangerous() {
  const v = process.env.SUPER_NOVA_EXEC;
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "off" && s !== "no";
}

export function toolCatalogText(dangerous) {
  const all = { ...SAFE_TOOLS, ...(dangerous ? DANGEROUS_TOOLS : {}) };
  const lines = Object.entries(all).map(([name, t]) => `- ${name}: ${t.desc}`);
  if (!dangerous) {
    lines.push(
      "(code/shell/file tools are disabled by configuration — do not call them.)",
    );
  }
  return lines.join("\n");
}

export async function runTool(name, args, ctx) {
  const dangerous = toolsEnabledDangerous();
  const reg = { ...SAFE_TOOLS, ...(dangerous ? DANGEROUS_TOOLS : {}) };
  const tool = reg[name];
  if (!tool) {
    if (DANGEROUS_TOOLS[name]) {
      return {
        error: `tool '${name}' is disabled. Set SUPER_NOVA_EXEC to enable code/shell/file tools.`,
      };
    }
    return { error: `unknown tool '${name}'.` };
  }
  try {
    return await tool.run(args || {}, ctx || {});
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
