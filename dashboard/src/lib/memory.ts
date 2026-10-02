import { Type, type Schema } from "@google/genai";
import { getDb } from "./db";
import {
  blobToVec,
  cosine,
  embedDocuments,
  embedQuery,
  vecToBlob,
} from "./embeddings";
import { getAI, withRetry, MODELS } from "./genai";
import type { MemoryItem, MemoryType } from "./types";

export const MEMORY_TYPES: MemoryType[] = [
  "preference",
  "fact",
  "person",
  "place",
  "plan",
  "interest",
];

// Above this cosine similarity a candidate is the same fact resurfacing —
// reinforce the stored memory instead of inserting a near-duplicate.
const DUPLICATE_SIM = 0.87;
// Between this and DUPLICATE_SIM the candidate is related but different enough
// that a small LLM call decides: new fact, duplicate, or an update that should
// replace the stored content (e.g. "moving to Austin" superseding "lives in SF").
const RELATED_SIM = 0.62;

const RECALL_WEIGHTS = {
  vector: 0.55, // semantic similarity
  keyword: 0.2, // FTS5 bm25 rank
  recency: 0.15, // exp decay over ~45 days
  strength: 0.1, // salience + reinforcement
};
const RECALL_MIN_SCORE = 0.3;

type MemoryRow = {
  id: string;
  rowid: number;
  type: string;
  category: string;
  content: string;
  entities: string;
  source_text: string;
  session_code: string;
  embedding: Buffer | null;
  salience: number;
  reinforcements: number;
  access_count: number;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
};

function rowToItem(row: MemoryRow): MemoryItem {
  let entities: string[] = [];
  try {
    entities = JSON.parse(row.entities);
  } catch {}
  return {
    id: row.id,
    type: (MEMORY_TYPES.includes(row.type as MemoryType)
      ? row.type
      : "fact") as MemoryType,
    category: row.category,
    content: row.content,
    entities,
    sourceText: row.source_text,
    salience: row.salience,
    reinforcements: row.reinforcements,
    accessCount: row.access_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// In-process vector cache — reloading every embedding per recall would be
// wasteful; invalidated on any write via bumpVersion().
// ---------------------------------------------------------------------------

type VecEntry = { rowid: number; vec: Float32Array };
const globalVec = globalThis as typeof globalThis & {
  __auralVecCache?: { version: number; entries: VecEntry[] };
  __auralVecVersion?: number;
};
globalVec.__auralVecVersion ??= 0;

function bumpVersion(): void {
  globalVec.__auralVecVersion = (globalVec.__auralVecVersion ?? 0) + 1;
}

function getVectors(): VecEntry[] {
  const version = globalVec.__auralVecVersion ?? 0;
  if (globalVec.__auralVecCache?.version === version) {
    return globalVec.__auralVecCache.entries;
  }
  const rows = getDb()
    .prepare(
      "SELECT rowid, embedding FROM memories WHERE embedding IS NOT NULL"
    )
    .all() as { rowid: number; embedding: Buffer }[];
  const entries: VecEntry[] = [];
  for (const r of rows) {
    const vec = blobToVec(r.embedding);
    if (vec) entries.push({ rowid: r.rowid, vec });
  }
  globalVec.__auralVecCache = { version, entries };
  return entries;
}

// ---------------------------------------------------------------------------
// Extraction — turn raw transcript into durable, canonical memories
// ---------------------------------------------------------------------------

const EXTRACT_PROMPT = `You are the long-term memory writer for a personal voice assistant. You watch a live conversation transcript and decide what is worth remembering about the user ACROSS conversations — the way a sharp personal assistant would.

Extract only DURABLE, REUSABLE information:
- "preference": likes, dislikes, habits ("User prefers window seats", "User is vegetarian")
- "fact": stable personal facts ("User lives in Boston", "User's daughter is named Maya")
- "person": people in the user's life and their relationship/details
- "place": cities, restaurants, venues the user has a real connection to (lives in, is visiting, loves)
- "plan": upcoming intents with a time dimension ("User is flying to Tokyo in August for a conference")
- "interest": recurring topics the user cares about ("User follows Formula 1")

Rules:
- Write "content" as one canonical third-person sentence starting with "User" (or the person's name for type "person"). Include the specifics: names, cities, foods, dates.
- "category" is a lowercase one-word grouping: food, travel, work, family, health, entertainment, shopping, other.
- "entities" lists the proper nouns / specific things mentioned (cities, dishes, airlines, people).
- "salience" 0-1: how much a good assistant would care to remember this. Passing mentions ≤ 0.4, identity-level facts ≥ 0.8.
- Convert relative dates to absolute using today's date.
- Do NOT store: small talk, greetings, one-off trivia questions, things about strangers, anything already implied by a memory-worthy line you're also returning.
- An empty list is often the right answer. Never invent details not in the transcript.`;

const extractSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    memories: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, enum: MEMORY_TYPES },
          category: { type: Type.STRING },
          content: { type: Type.STRING },
          entities: { type: Type.ARRAY, items: { type: Type.STRING } },
          salience: { type: Type.NUMBER },
        },
        required: ["type", "category", "content", "entities", "salience"],
      },
    },
  },
  required: ["memories"],
};

type Candidate = {
  type: MemoryType;
  category: string;
  content: string;
  entities: string[];
  salience: number;
};

const consolidateSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    decisions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          candidateIndex: { type: Type.NUMBER },
          action: { type: Type.STRING, enum: ["new", "duplicate", "update"] },
          targetId: { type: Type.STRING },
          mergedContent: { type: Type.STRING },
        },
        required: ["candidateIndex", "action"],
      },
    },
  },
  required: ["decisions"],
};

/**
 * Extract memories from the latest transcript window and store them,
 * consolidating against what's already known. Designed to be called
 * fire-and-forget (via next/server `after`) on each analyzed utterance.
 */
export async function extractAndStore(
  transcript: string,
  sessionCode: string
): Promise<MemoryItem[]> {
  const ai = getAI();
  const text = transcript.trim();
  if (!ai || text.split(/\s+/).length < 4) return [];

  const today = new Date().toISOString().slice(0, 10);
  let candidates: Candidate[] = [];
  try {
    const res = await withRetry(() =>
      ai.models.generateContent({
        model: MODELS.fast,
        contents: `Today's date: ${today}\n\nTranscript window:\n${text}\n\nExtract durable memories as JSON.`,
        config: {
          systemInstruction: EXTRACT_PROMPT,
          responseMimeType: "application/json",
          responseSchema: extractSchema,
          temperature: 0.2,
        },
      })
    );
    const parsed = JSON.parse(res.text ?? "{}") as { memories?: Candidate[] };
    candidates = (parsed.memories ?? []).filter(
      (c) =>
        c.content?.trim() &&
        MEMORY_TYPES.includes(c.type) &&
        typeof c.salience === "number"
    );
  } catch {
    return [];
  }
  if (candidates.length === 0) return [];

  const vecs = await embedDocuments(candidates.map((c) => c.content));

  // Partition candidates by similarity to what we already know.
  const db = getDb();
  const byRowid = db.prepare("SELECT * FROM memories WHERE rowid = ?");
  const stored: MemoryItem[] = [];
  const needsJudgment: {
    index: number;
    neighbors: { id: string; content: string; sim: number }[];
  }[] = [];

  const vectors = getVectors();
  for (let i = 0; i < candidates.length; i++) {
    const vec = vecs?.[i] ?? null;
    let best: { row: MemoryRow; sim: number } | null = null;
    const neighbors: { id: string; content: string; sim: number }[] = [];
    if (vec) {
      const scored = vectors
        .map((e) => ({ rowid: e.rowid, sim: cosine(vec, e.vec) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 3);
      for (const s of scored) {
        if (s.sim < RELATED_SIM) continue;
        const row = byRowid.get(s.rowid) as MemoryRow | undefined;
        if (!row) continue;
        if (!best || s.sim > best.sim) best = { row, sim: s.sim };
        neighbors.push({ id: row.id, content: row.content, sim: s.sim });
      }
    }

    if (best && best.sim >= DUPLICATE_SIM) {
      reinforce(best.row.id, candidates[i].salience);
      continue;
    }
    if (neighbors.length > 0) {
      needsJudgment.push({ index: i, neighbors });
      continue;
    }
    const item = insertMemory(candidates[i], vec, transcript, sessionCode);
    stored.push(item);
  }

  // Borderline cases: one cheap LLM call decides new / duplicate / update.
  if (needsJudgment.length > 0) {
    const prompt = needsJudgment
      .map(({ index, neighbors }) => {
        const n = neighbors
          .map((x) => `  - id=${x.id}: "${x.content}"`)
          .join("\n");
        return `Candidate ${index}: "${candidates[index].content}"\nExisting similar memories:\n${n}`;
      })
      .join("\n\n");
    try {
      const res = await withRetry(() =>
        ai.models.generateContent({
          model: MODELS.fast,
          contents: `${prompt}\n\nFor each candidate decide: "duplicate" (existing memory already says this — targetId required), "update" (candidate supersedes or enriches an existing memory — targetId + mergedContent required, mergedContent is ONE sentence combining/replacing correctly, newest info wins), or "new" (genuinely different fact).`,
          config: {
            responseMimeType: "application/json",
            responseSchema: consolidateSchema,
            temperature: 0.1,
          },
        })
      );
      const parsed = JSON.parse(res.text ?? "{}") as {
        decisions?: {
          candidateIndex: number;
          action: "new" | "duplicate" | "update";
          targetId?: string;
          mergedContent?: string;
        }[];
      };
      const decided = new Set<number>();
      for (const d of parsed.decisions ?? []) {
        const cand = candidates[d.candidateIndex];
        const pending = needsJudgment.find(
          (x) => x.index === d.candidateIndex
        );
        if (!cand || !pending || decided.has(d.candidateIndex)) continue;
        decided.add(d.candidateIndex);

        if (d.action === "duplicate" && d.targetId) {
          reinforce(d.targetId, cand.salience);
        } else if (d.action === "update" && d.targetId && d.mergedContent) {
          const updated = await updateContent(
            d.targetId,
            d.mergedContent,
            cand
          );
          if (updated) stored.push(updated);
        } else {
          stored.push(
            insertMemory(
              cand,
              vecs?.[d.candidateIndex] ?? null,
              transcript,
              sessionCode
            )
          );
        }
      }
      // Anything the judge skipped still gets stored — losing info is worse
      // than an occasional near-duplicate.
      for (const { index } of needsJudgment) {
        if (!decided.has(index)) {
          stored.push(
            insertMemory(
              candidates[index],
              vecs?.[index] ?? null,
              transcript,
              sessionCode
            )
          );
        }
      }
    } catch {
      for (const { index } of needsJudgment) {
        stored.push(
          insertMemory(
            candidates[index],
            vecs?.[index] ?? null,
            transcript,
            sessionCode
          )
        );
      }
    }
  }

  return stored;
}

function insertMemory(
  c: Candidate,
  vec: Float32Array | null,
  sourceText: string,
  sessionCode: string
): MemoryItem {
  const db = getDb();
  const now = Date.now();
  const id = uid();
  db.prepare(
    `INSERT INTO memories
       (id, type, category, content, entities, source_text, session_code,
        embedding, salience, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    c.type,
    (c.category || "other").toLowerCase(),
    c.content.trim(),
    JSON.stringify(c.entities ?? []),
    sourceText.slice(0, 2000),
    sessionCode,
    vec ? vecToBlob(vec) : null,
    Math.max(0, Math.min(1, c.salience)),
    now,
    now
  );
  bumpVersion();
  const row = db
    .prepare("SELECT rowid, * FROM memories WHERE id = ?")
    .get(id) as MemoryRow;
  return rowToItem(row);
}

/** Same fact resurfaced — strengthen it instead of duplicating. */
function reinforce(id: string, salience: number): void {
  getDb()
    .prepare(
      `UPDATE memories
       SET reinforcements = reinforcements + 1,
           salience = MAX(salience, ?),
           updated_at = ?
       WHERE id = ?`
    )
    .run(Math.max(0, Math.min(1, salience)), Date.now(), id);
}

/** Newer info supersedes: rewrite content (and its embedding). */
async function updateContent(
  id: string,
  mergedContent: string,
  cand: Candidate
): Promise<MemoryItem | null> {
  const db = getDb();
  const row = db
    .prepare("SELECT rowid, * FROM memories WHERE id = ?")
    .get(id) as MemoryRow | undefined;
  if (!row) return null;

  const vecs = await embedDocuments([mergedContent]);
  const entities = new Set<string>();
  try {
    for (const e of JSON.parse(row.entities)) entities.add(e);
  } catch {}
  for (const e of cand.entities ?? []) entities.add(e);

  db.prepare(
    `UPDATE memories
     SET content = ?, entities = ?, embedding = COALESCE(?, embedding),
         reinforcements = reinforcements + 1,
         salience = MAX(salience, ?), updated_at = ?
     WHERE id = ?`
  ).run(
    mergedContent.trim(),
    JSON.stringify([...entities]),
    vecs ? vecToBlob(vecs[0]) : null,
    Math.max(0, Math.min(1, cand.salience)),
    Date.now(),
    id
  );
  bumpVersion();
  const updated = db
    .prepare("SELECT rowid, * FROM memories WHERE id = ?")
    .get(id) as MemoryRow;
  return rowToItem(updated);
}

// ---------------------------------------------------------------------------
// Recall — hybrid semantic + keyword + recency + strength retrieval
// ---------------------------------------------------------------------------

function ftsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, 10);
  return [...new Set(tokens)].map((t) => `"${t}"`).join(" OR ");
}

/**
 * Retrieve the memories most relevant to `query`. Scoring blends vector
 * similarity, keyword rank, recency decay, and memory strength; falls back
 * to keyword+recency alone when embeddings are unavailable.
 */
export async function recall(
  query: string,
  opts: { limit?: number; minScore?: number } = {}
): Promise<(MemoryItem & { score: number })[]> {
  const db = getDb();
  const limit = opts.limit ?? 6;
  const minScore = opts.minScore ?? RECALL_MIN_SCORE;
  const trimmed = query.trim();
  if (!trimmed) return [];

  const total = (
    db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }
  ).c;
  if (total === 0) return [];

  const qvec = await embedQuery(trimmed);

  // Vector similarity over the cached embedding matrix.
  const vecScores = new Map<number, number>();
  if (qvec) {
    for (const e of getVectors()) {
      vecScores.set(e.rowid, Math.max(0, cosine(qvec, e.vec)));
    }
  }

  // Keyword rank via FTS5 bm25 (lower is better) → normalized by position.
  const kwScores = new Map<number, number>();
  const match = ftsQuery(trimmed);
  if (match) {
    try {
      const rows = db
        .prepare(
          `SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?
           ORDER BY bm25(memories_fts) LIMIT 50`
        )
        .all(match) as { rowid: number }[];
      rows.forEach((r, i) => kwScores.set(r.rowid, 1 - i / rows.length));
    } catch {
      // odd tokens can still break MATCH — keyword channel just contributes 0
    }
  }

  const now = Date.now();
  const dayMs = 86_400_000;
  const rows = db
    .prepare("SELECT rowid, * FROM memories")
    .all() as MemoryRow[];

  // Without embeddings the vector channel is dead weight — renormalize so
  // keyword+recency+strength carry the decision.
  const wTotal = qvec
    ? 1
    : RECALL_WEIGHTS.keyword + RECALL_WEIGHTS.recency + RECALL_WEIGHTS.strength;

  const scored = rows
    .map((row) => {
      const ageDays = (now - row.updated_at) / dayMs;
      const recency = Math.exp(-ageDays / 45);
      const strength =
        0.6 * row.salience + 0.4 * Math.min(1, row.reinforcements / 5);
      const score =
        (RECALL_WEIGHTS.vector * (vecScores.get(row.rowid) ?? 0) +
          RECALL_WEIGHTS.keyword * (kwScores.get(row.rowid) ?? 0) +
          RECALL_WEIGHTS.recency * recency +
          RECALL_WEIGHTS.strength * strength) /
        wTotal;
      return { row, score };
    })
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length > 0) {
    const touch = db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE rowid = ?"
    );
    const tx = db.transaction((items: typeof scored) => {
      for (const s of items) touch.run(now, s.row.rowid);
    });
    tx(scored);
  }

  return scored.map((s) => ({ ...rowToItem(s.row), score: s.score }));
}

/** Compact recall block for prompt injection, or "" when nothing relevant. */
export async function recallForPrompt(
  query: string,
  limit = 6
): Promise<{ block: string; items: (MemoryItem & { score: number })[] }> {
  const items = await recall(query, { limit });
  if (items.length === 0) return { block: "", items };
  const block = items
    .map((m) => `- [${m.type}/${m.category}] ${m.content}`)
    .join("\n");
  return { block, items };
}

// ---------------------------------------------------------------------------
// CRUD for the UI / agent tools
// ---------------------------------------------------------------------------

export function listMemories(
  opts: { q?: string; type?: string; limit?: number } = {}
): MemoryItem[] {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 100, 500);

  if (opts.q?.trim()) {
    const match = ftsQuery(opts.q);
    if (match) {
      try {
        const rows = db
          .prepare(
            `SELECT m.rowid, m.* FROM memories m
             JOIN memories_fts f ON f.rowid = m.rowid
             WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`
          )
          .all(match, limit) as MemoryRow[];
        return rows.map(rowToItem);
      } catch {}
    }
  }

  const rows = (
    opts.type
      ? db
          .prepare(
            "SELECT rowid, * FROM memories WHERE type = ? ORDER BY updated_at DESC LIMIT ?"
          )
          .all(opts.type, limit)
      : db
          .prepare(
            "SELECT rowid, * FROM memories ORDER BY updated_at DESC LIMIT ?"
          )
          .all(limit)
  ) as MemoryRow[];
  return rows.map(rowToItem);
}

export function memoryStats(): { total: number; byType: Record<string, number> } {
  const db = getDb();
  const total = (
    db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }
  ).c;
  const rows = db
    .prepare("SELECT type, COUNT(*) AS c FROM memories GROUP BY type")
    .all() as { type: string; c: number }[];
  return {
    total,
    byType: Object.fromEntries(rows.map((r) => [r.type, r.c])),
  };
}

export function deleteMemory(id: string): boolean {
  const res = getDb().prepare("DELETE FROM memories WHERE id = ?").run(id);
  if (res.changes > 0) bumpVersion();
  return res.changes > 0;
}

/** Manual/agent-initiated save. Runs the same dedup path as extraction. */
export async function saveMemory(
  input: {
    type?: string;
    category?: string;
    content: string;
    entities?: string[];
    salience?: number;
  },
  sessionCode: string
): Promise<MemoryItem | null> {
  const content = input.content?.trim();
  if (!content) return null;
  const cand: Candidate = {
    type: MEMORY_TYPES.includes(input.type as MemoryType)
      ? (input.type as MemoryType)
      : "fact",
    category: (input.category || "other").toLowerCase(),
    content,
    entities: input.entities ?? [],
    salience: input.salience ?? 0.6,
  };
  const vecs = await embedDocuments([content]);
  const vec = vecs?.[0] ?? null;

  if (vec) {
    let best: { rowid: number; sim: number } | null = null;
    for (const e of getVectors()) {
      const sim = cosine(vec, e.vec);
      if (!best || sim > best.sim) best = { rowid: e.rowid, sim };
    }
    if (best && best.sim >= DUPLICATE_SIM) {
      const row = getDb()
        .prepare("SELECT rowid, * FROM memories WHERE rowid = ?")
        .get(best.rowid) as MemoryRow;
      reinforce(row.id, cand.salience);
      return rowToItem(row);
    }
  }
  return insertMemory(cand, vec, content, sessionCode);
}
