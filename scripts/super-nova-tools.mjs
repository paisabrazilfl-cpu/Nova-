// super-nova-tools.mjs — the tool registry for SUPER NOVA, the Work Tree's
// tool-using agent loop. Terminal nodes call these tools through a bounded ReAct
// loop (see work-tree-worker.mjs) to do real work instead of LLM text only.
//
// Two tiers:
//   SAFE      — always available, no new secrets, low blast radius:
//               http_fetch (SSRF-guarded), web_search (needs a provider key,
//               degrades gracefully), image_generate (Bitdeer).
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
  await assertSafeUrl(url);
  const headers =
    args.headers && typeof args.headers === "object" ? args.headers : {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body:
        args.body != null && method !== "GET" && method !== "HEAD"
          ? String(args.body)
          : undefined,
      signal: ctrl.signal,
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      return {
        status: res.status,
        redirectTo: res.headers.get("location") || "",
        note: "redirect not followed — re-fetch the redirect URL to keep the SSRF guard in effect",
      };
    }
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      body: text.slice(0, MAX_BODY),
      truncated: text.length > MAX_BODY,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function webSearch(args) {
  const q = String(args.query || "").slice(0, 400);
  if (!q) return { error: "query required" };
  try {
    if (process.env.TAVILY_API_KEY) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query: q,
          max_results: 5,
        }),
      });
      if (!res.ok) return { error: `tavily ${res.status}` };
      const j = await res.json();
      return {
        provider: "tavily",
        results: (j.results || []).slice(0, 5).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: String(r.content || "").slice(0, 300),
        })),
      };
    }
    if (process.env.BRAVE_API_KEY) {
      const res = await fetch(
        "https://api.search.brave.com/res/v1/web/search?count=5&q=" +
          encodeURIComponent(q),
        {
          headers: {
            "X-Subscription-Token": process.env.BRAVE_API_KEY,
            Accept: "application/json",
          },
        },
      );
      if (!res.ok) return { error: `brave ${res.status}` };
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
    if (process.env.FIRECRAWL_API_KEY) {
      const res = await fetch("https://api.firecrawl.dev/v1/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: q, limit: 5 }),
      });
      if (!res.ok) return { error: `firecrawl ${res.status}` };
      const j = await res.json();
      return {
        provider: "firecrawl",
        results: (j.data || []).slice(0, 5).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: String(r.description || "").slice(0, 300),
        })),
      };
    }
  } catch (e) {
    return { error: `search failed: ${e.message || e}` };
  }
  return {
    error:
      "web_search unavailable: no search provider key set " +
      "(TAVILY_API_KEY / BRAVE_API_KEY / FIRECRAWL_API_KEY). " +
      "Use http_fetch on a known URL instead.",
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
    desc: 'fetch an http/https URL. args: {url, method?, headers?, body?}. Private/internal/metadata addresses are blocked; redirects are not auto-followed. Returns {status, contentType, body (truncated)}.',
  },
  web_search: {
    run: webSearch,
    desc: 'search the web. args: {query}. Needs a provider key; if none is set it returns an error telling you to use http_fetch on a known URL.',
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
