import express, { Router, type IRouter } from "express";

// Server-side voice-to-text (Whisper). The browser records audio and POSTs the
// raw bytes here; we forward to OpenAI with the SERVER key so no OpenAI key ever
// has to live in the browser (the old client-side path failed whenever the
// operator hadn't pasted a personal key). Body is raw audio, not JSON, so we use
// a route-scoped raw parser (the global express.json() ignores audio/* types).
const router: IRouter = Router();

const OPENAI_BASE = "https://api.openai.com";

router.post(
  "/voice/transcribe",
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    const key = process.env["OPENAI_API_KEY"] ?? "";
    if (!key) {
      res.status(503).json({ error: "OPENAI_API_KEY is not configured on this server." });
      return;
    }
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: "no audio received" });
      return;
    }
    const mime = String(req.headers["content-type"] || "audio/webm");
    const ext = /mp4|m4a|aac/.test(mime) ? "m4a" : /wav/.test(mime) ? "wav" : /mpeg|mp3/.test(mime) ? "mp3" : "webm";
    try {
      const form = new FormData();
      form.append("file", new Blob([buf], { type: mime }), `clip.${ext}`);
      form.append("model", "whisper-1");
      const r = await fetch(`${OPENAI_BASE}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      const text = await r.text();
      if (!r.ok) {
        res.status(502).json({ error: "transcription failed", status: r.status, detail: text.slice(0, 300) });
        return;
      }
      let parsed: { text?: string };
      try { parsed = JSON.parse(text); } catch { parsed = {}; }
      res.json({ text: (parsed.text ?? "").trim() });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);

export default router;
