import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM_PROMPT = `You are a real-time conversation co-pilot watching a live transcript.

Your job: scan the latest snippet for SPECIFIC, ACTIONABLE references the speaker made — products, places, people, businesses, topics — and surface a tiny "would you like to act on this?" card with a useful link.

Rules:
- Only surface concrete entities the speaker actually mentioned. No speculation.
- Prefer ONE great suggestion over three weak ones. Often the right answer is zero.
- Skip greetings, filler, abstract concepts, and anything already obvious.
- Be terse. Title under 40 chars. Description one short sentence.

Kinds and link formats:
- "shop": product purchase intent → https://www.amazon.com/s?k=<query>
- "search": research / look-up intent → https://www.google.com/search?q=<query>
- "map": place, restaurant, address → https://www.google.com/maps/search/?api=1&query=<query>
- "calendar": event being scheduled → https://calendar.google.com/calendar/u/0/r/eventedit?text=<title>
- "info": general knowledge card → Wikipedia URL https://en.wikipedia.org/wiki/Special:Search?search=<query>

Encode the query with %20 for spaces. Return the JSON object only.`;

const responseSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    suggestions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          kind: {
            type: SchemaType.STRING,
            format: "enum",
            enum: ["shop", "search", "map", "calendar", "info"],
          },
          title: { type: SchemaType.STRING },
          description: { type: SchemaType.STRING },
          url: { type: SchemaType.STRING },
          actionLabel: { type: SchemaType.STRING },
        },
        required: ["kind", "title", "description", "url", "actionLabel"],
      },
    },
  },
  required: ["suggestions"],
};

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "GEMINI_API_KEY not configured", suggestions: [] },
      { status: 500 }
    );
  }

  let body: { recent?: string; lastFinal?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON", suggestions: [] }, { status: 400 });
  }

  const recent = (body.recent ?? "").trim();
  const lastFinal = (body.lastFinal ?? "").trim();

  if (!lastFinal && !recent) {
    return Response.json({ suggestions: [] });
  }

  const userPrompt = `Recent context:\n${recent || "(no prior context)"}\n\nLatest line:\n"${lastFinal}"\n\nDoes the latest line reference something specific and actionable? Return suggestions JSON.`;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.3,
        maxOutputTokens: 512,
      },
    });

    const result = await model.generateContent(userPrompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);
    return Response.json(parsed);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: msg, suggestions: [] },
      { status: 500 }
    );
  }
}
