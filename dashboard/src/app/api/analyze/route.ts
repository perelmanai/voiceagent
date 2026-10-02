import { Type, type Schema } from "@google/genai";
import type { NextRequest } from "next/server";
import { after } from "next/server";
import { getAI, withRetry, MODELS } from "@/lib/genai";
import { extractAndStore, recallForPrompt } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM_PROMPT = `You are a real-time conversation co-pilot watching a live transcript, backed by a long-term memory of the user.

Your job: scan the latest snippet for SPECIFIC, ACTIONABLE references the speaker made — products, places, people, businesses, topics, tasks — and surface a tiny "would you like to act on this?" card.

Rules:
- Only surface concrete entities or intents the speaker actually mentioned. No speculation.
- Prefer ONE great suggestion over three weak ones. Often the right answer is zero.
- Skip greetings, filler, abstract concepts, and anything already obvious.
- USE the "Known about the user" memory block to sharpen suggestions: their home city for travel, their food preferences for restaurants, their plans for scheduling. A suggestion that reflects remembered context beats a generic one.
- Be terse. Title under 40 chars. Description one short sentence.

Kinds and link formats:
- "shop": product purchase intent → https://www.amazon.com/s?k=<query>
- "search": research / look-up intent → https://www.google.com/search?q=<query>
- "map": place, restaurant, address → https://www.google.com/maps/search/?api=1&query=<query>
- "calendar": event being scheduled → https://calendar.google.com/calendar/u/0/r/eventedit?text=<title>
- "info": general knowledge card → Wikipedia URL https://en.wikipedia.org/wiki/Special:Search?search=<query>
- "agent": the speaker expressed a MULTI-STEP task an autonomous browser agent should DO for them (book a flight, reserve a table, order something, compare and pick an option). Set "task" to one crisp imperative instruction including every detail the speaker gave (and relevant remembered context). Set url to "" and actionLabel to "Run agent".

Prefer "agent" over a plain link whenever the speaker clearly wants something DONE rather than just looked at.

Encode the query with %20 for spaces. Return the JSON object only.`;

const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    suggestions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: {
            type: Type.STRING,
            enum: ["shop", "search", "map", "calendar", "info", "agent"],
          },
          title: { type: Type.STRING },
          description: { type: Type.STRING },
          url: { type: Type.STRING },
          actionLabel: { type: Type.STRING },
          task: { type: Type.STRING },
        },
        required: ["kind", "title", "description", "url", "actionLabel"],
      },
    },
  },
  required: ["suggestions"],
};

export async function POST(request: NextRequest) {
  const ai = getAI();
  if (!ai) {
    return Response.json(
      { error: "GEMINI_API_KEY not configured", suggestions: [] },
      { status: 500 }
    );
  }

  let body: { recent?: string; lastFinal?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON", suggestions: [] }, { status: 400 });
  }

  const recent = (body.recent ?? "").trim();
  const lastFinal = (body.lastFinal ?? "").trim();
  const sessionCode = (body.code ?? "").trim().toUpperCase();

  if (!lastFinal && !recent) {
    return Response.json({ suggestions: [] });
  }

  // Long-term memory relevant to what was just said.
  const { block: memoryBlock, items: recalled } = await recallForPrompt(
    `${lastFinal} ${recent}`.slice(0, 600),
    6
  );

  const userPrompt = `Known about the user (long-term memory):\n${
    memoryBlock || "(nothing yet)"
  }\n\nRecent context:\n${recent || "(no prior context)"}\n\nLatest line:\n"${lastFinal}"\n\nDoes the latest line reference something specific and actionable? Return suggestions JSON.`;

  // Memory extraction runs after the response is sent — it must never add
  // latency to the live suggestion loop.
  after(async () => {
    try {
      await extractAndStore(recent || lastFinal, sessionCode);
    } catch {
      // extraction is best-effort
    }
  });

  try {
    const result = await withRetry(() =>
      ai.models.generateContent({
        model: MODELS.fast,
        contents: userPrompt,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0.3,
          maxOutputTokens: 1024,
        },
      })
    );
    const parsed = JSON.parse(result.text ?? "{}");
    return Response.json({
      ...parsed,
      recalled: recalled.map((m) => ({
        id: m.id,
        type: m.type,
        content: m.content,
      })),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json({ error: msg, suggestions: [] }, { status: 500 });
  }
}
