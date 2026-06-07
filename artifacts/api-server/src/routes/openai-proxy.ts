import { Router } from "express";
import {
  conversationKeyFor,
  lastUserText,
  recordTurn,
  getMemoryDigest,
  type ChatMessage,
} from "../lib/scratchpad";
import { getKnowledgeContext } from "../lib/knowledge";

const router = Router();

const OPENAI_BASE = "https://api.openai.com";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";

// Bitdeer: OpenAI-compatible endpoint that hosts OSS + proprietary models.
const BITDEER_BASE = "https://api-inference.bitdeer.ai";
const BITDEER_KEY = process.env.BITDEER_API_KEY ?? "";

// Google Gemini via their OpenAI-compatible shim.
// Path stripping: their base already includes /v1beta/openai, so drop the
// leading /v1 that the client sends (e.g. /v1/chat/completions → /chat/completions).
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";

function pickProvider(model: string): {
  url: (path: string) => string;
  key: string;
} {
  // gemini-* → Google's OpenAI-compatible shim (strip leading /v1).
  // Only if GEMINI_KEY is present and non-empty.
  if (model.startsWith("gemini-") && GEMINI_KEY) {
    return {
      url: (path) => `${GEMINI_BASE}${path.replace(/^\/v1/, "")}`,
      key: GEMINI_KEY,
    };
  }
  // gpt-* → OpenAI directly (confirmed valid service-account key).
  if (model.startsWith("gpt-") && OPENAI_KEY) {
    return { url: (path) => `${OPENAI_BASE}${path}`, key: OPENAI_KEY };
  }
  // Everything else (deepseek-*, qwen-*, kimi-*, mistral-*, etc.) → Bitdeer.
  if (BITDEER_KEY) {
    return { url: (path) => `${BITDEER_BASE}${path}`, key: BITDEER_KEY };
  }
  // Last resort fallback.
  return { url: (path) => `${OPENAI_BASE}${path}`, key: OPENAI_KEY };
}

const MEMORY_HEADER =
  "Continuity memory — things you already know about Robert from past conversations. " +
  "Use it naturally for context; do not recite it or mention that you have notes.\n";

const KNOWLEDGE_HEADER =
  "Knowledge base — relevant passages retrieved from Robert's notes, files, SOPs, " +
  "leads and transcripts. Ground your answer in these when applicable; cite naturally, " +
  "do not mention that they were retrieved.\n";

// Pull assistant text out of a streamed SSE chunk so we can capture the reply.
function extractDeltas(buffer: string): { text: string; rest: string } {
  let text = "";
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    } catch {
      // partial JSON across chunks — ignore, handled by buffering
    }
  }
  return { text, rest };
}

// Streaming proxy — mounted on the router at /api, so req.path within this router
// is e.g. /v1/chat/completions or /v1/audio/speech. Forwards everything under
// /v1/* to OpenAI with the server-side key, so the key never reaches the browser.
router.all("/v1/*splat", async (req, res) => {
  const qs = req.url.slice(req.path.length);

  const isChat =
    req.method === "POST" &&
    req.path === "/v1/chat/completions" &&
    req.body != null &&
    Array.isArray(req.body.messages);

  // Memory injection + capture setup (best-effort; never blocks the chat).
  let convKey: string | null = null;
  let userText = "";
  const model: string = isChat ? String(req.body.model ?? "") : "";
  const provider = pickProvider(model);
  const upstreamUrl = `${provider.url(req.path)}${qs}`;
  const API_KEY = provider.key;
  if (isChat) {
    const messages = req.body.messages as ChatMessage[];
    convKey = conversationKeyFor(messages);
    userText = lastUserText(messages);
    try {
      const digest = await getMemoryDigest();
      if (digest) {
        const memoryMsg = { role: "system", content: MEMORY_HEADER + digest };
        const firstNonSystem = messages.findIndex((m) => m.role !== "system");
        const at = firstNonSystem === -1 ? messages.length : firstNonSystem;
        messages.splice(at, 0, memoryMsg);
      }
    } catch (e) {
      req.log.warn({ err: e }, "scratchpad memory injection skipped");
    }
    if (process.env.NOVA_KNOWLEDGE_RETRIEVAL !== "0") {
      try {
        const ctx = await getKnowledgeContext(userText, 3);
        if (ctx) {
          const knowledgeMsg = { role: "system", content: KNOWLEDGE_HEADER + ctx };
          const firstNonSystem = messages.findIndex((m) => m.role !== "system");
          const at = firstNonSystem === -1 ? messages.length : firstNonSystem;
          messages.splice(at, 0, knowledgeMsg);
        }
      } catch (e) {
        req.log.warn({ err: e }, "knowledge retrieval skipped");
      }
    }
  }

  const hasBody =
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    req.body != null &&
    Object.keys(req.body).length > 0;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        Accept: req.headers.accept ?? "*/*",
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
      duplex: "half",
    });

    res.status(upstream.status);

    const skipHeaders = new Set([
      "transfer-encoding",
      "connection",
      "keep-alive",
      "upgrade",
      "proxy-authenticate",
      "proxy-authorization",
      // fetch() auto-decompresses — strip these so clients don't double-decompress
      "content-encoding",
      "content-length",
    ]);
    upstream.headers.forEach((v, k) => {
      if (!skipHeaders.has(k.toLowerCase())) res.setHeader(k, v);
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    const captureOk = isChat && convKey && upstream.ok;
    let assistantText = "";
    let sseBuffer = "";
    const decoder = new TextDecoder();

    const reader = upstream.body.getReader();
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (captureOk && value) {
          sseBuffer += decoder.decode(value, { stream: true });
          const { text, rest } = extractDeltas(sseBuffer);
          assistantText += text;
          sseBuffer = rest;
        }
        const ok = res.write(value);
        if (!ok) await new Promise<void>((r) => res.once("drain", r));
      }
      res.end();

      if (captureOk) {
        recordTurn({
          conversationKey: convKey!,
          userText,
          assistantText,
          model,
        }).catch((e) => req.log.warn({ err: e }, "scratchpad recordTurn failed"));
      }
    };
    pump().catch((e) => {
      req.log.error({ err: e }, "openai-proxy stream error");
      res.end();
    });
  } catch (e) {
    req.log.error({ err: e }, "openai-proxy fetch error");
    if (!res.headersSent) res.status(502).json({ error: "upstream unreachable" });
  }
});

export default router;
