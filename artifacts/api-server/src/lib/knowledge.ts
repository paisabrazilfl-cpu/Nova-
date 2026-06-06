import { db, knowledgeChunksTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const OPENAI_BASE = "https://api.openai.com/v1";
const OPENAI_EMBED_MODEL = "text-embedding-3-small";

function embedConfig(): {
  url: string;
  key: string;
  body: Record<string, unknown>;
} {
  const oa = process.env.OPENAI_API_KEY ?? "";
  if (oa) {
    return {
      url: `${OPENAI_BASE}/embeddings`,
      key: oa,
      body: { model: OPENAI_EMBED_MODEL },
    };
  }
  throw new Error("no embeddings provider configured (OPENAI_API_KEY)");
}

// Embed a single string (1536-dim). Uses a server-side key so the browser never
// sees it.
export async function embed(input: string): Promise<number[]> {
  const { url, key, body } = embedConfig();
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ ...body, input }),
  });
  if (!r.ok) throw new Error(`embeddings failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { data: { embedding: number[] }[] };
  return j.data[0]!.embedding;
}

// Split long text into overlapping chunks suitable for embedding.
export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    chunks.push(clean.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
}

export interface IngestOpts {
  source?: string;
  title?: string;
  content: string;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
}

// Cap chunks per ingest call: each chunk is one embeddings API call, so an
// unbounded document would let a single request rack up cost/latency.
const MAX_CHUNKS_PER_INGEST = 60;

// Chunk → embed → store. Returns the inserted row ids.
export async function ingestText(opts: IngestOpts): Promise<number[]> {
  const chunks = chunkText(opts.content);
  if (chunks.length > MAX_CHUNKS_PER_INGEST) {
    throw new Error(
      `content too large: ${chunks.length} chunks exceeds limit of ${MAX_CHUNKS_PER_INGEST}`,
    );
  }
  const ids: number[] = [];
  for (const ch of chunks) {
    const vec = await embed(ch);
    const [row] = await db
      .insert(knowledgeChunksTable)
      .values({
        source: opts.source ?? "manual",
        title: opts.title ?? "",
        content: ch,
        externalId: opts.externalId ?? null,
        embedding: vec,
        metadata: (opts.metadata ?? {}) as Record<string, unknown>,
      })
      .returning({ id: knowledgeChunksTable.id });
    if (row) ids.push(row.id);
  }
  return ids;
}

export interface KnowledgeHit {
  id: number;
  source: string;
  title: string;
  content: string;
  score: number;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const r = result as { rows?: Record<string, unknown>[] };
  if (Array.isArray(r.rows)) return r.rows;
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

// Cosine-similarity search. Higher score = closer match (1 - distance).
export async function searchKnowledge(
  query: string,
  limit = 5,
): Promise<KnowledgeHit[]> {
  const vec = await embed(query);
  const lit = `[${vec.join(",")}]`;
  const result = await db.execute(sql`
    SELECT id, source, title, content, 1 - (embedding <=> ${lit}::vector) AS score
    FROM knowledge_chunks
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${lit}::vector
    LIMIT ${limit}
  `);
  return rowsOf(result).map((r) => ({
    id: Number(r.id),
    source: String(r.source ?? ""),
    title: String(r.title ?? ""),
    content: String(r.content ?? ""),
    score: Number(r.score ?? 0),
  }));
}

export async function hasKnowledge(): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT 1 FROM knowledge_chunks WHERE embedding IS NOT NULL LIMIT 1`,
  );
  return rowsOf(result).length > 0;
}

// Build a compact retrieval context for a user message. Returns "" when the KB
// is empty, nothing is relevant, or anything fails — callers inject it
// best-effort and must never let it break the chat.
export async function getKnowledgeContext(
  query: string,
  limit = 3,
): Promise<string> {
  try {
    if (!query.trim()) return "";
    if (!(await hasKnowledge())) return "";
    const hits = await searchKnowledge(query, limit);
    const good = hits.filter((h) => h.score > 0.2);
    if (!good.length) return "";
    return good
      .map((h, i) => `[${i + 1}] ${h.title ? h.title + " — " : ""}${h.content}`)
      .join("\n\n");
  } catch {
    return "";
  }
}
