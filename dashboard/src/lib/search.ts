import { getAI, withRetry, MODELS } from "./genai";

export type SearchResult = {
  answer: string;
  sources: { title: string; url: string }[];
};

/**
 * Web search for the agent. Primary: Gemini with Google Search grounding
 * (no extra API key needed). Fallback when quota-limited or unavailable:
 * scrape DuckDuckGo's HTML endpoint, which needs no key at all.
 */
export async function webSearch(query: string): Promise<SearchResult> {
  const q = query.trim();
  if (!q) return { answer: "", sources: [] };

  const ai = getAI();
  if (ai) {
    try {
      const res = await withRetry(() =>
        ai.models.generateContent({
          model: MODELS.agent,
          contents: `Search the web and answer concisely with concrete facts (names, prices, dates, URLs when relevant): ${q}`,
          config: { tools: [{ googleSearch: {} }] },
        })
      );
      const chunks =
        res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const sources = chunks
        .map((c) => ({
          title: c.web?.title ?? "",
          url: c.web?.uri ?? "",
        }))
        .filter((s) => s.url);
      const answer = (res.text ?? "").trim();
      if (answer) return { answer, sources };
    } catch {
      // fall through to DuckDuckGo
    }
  }
  return duckDuckGo(q);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

async function duckDuckGo(query: string): Promise<SearchResult> {
  try {
    const res = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) AuralIntel/1.0" },
        signal: AbortSignal.timeout(15_000),
      }
    );
    const html = await res.text();
    const sources: { title: string; url: string }[] = [];
    const linkRe =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) && sources.length < 8) {
      let url = m[1];
      // DDG wraps results in a redirect: //duckduckgo.com/l/?uddg=<encoded>
      const uddg = url.match(/[?&]uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      const title = decodeEntities(m[2].replace(/<[^>]+>/g, "").trim());
      if (title && url.startsWith("http")) sources.push({ title, url });
    }
    const snippets: string[] = [];
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = snipRe.exec(html)) && snippets.length < 5) {
      const s = decodeEntities(m[1].replace(/<[^>]+>/g, "").trim());
      if (s) snippets.push(s);
    }
    return {
      answer: snippets.join("\n") || "(no snippet summary available)",
      sources,
    };
  } catch {
    return { answer: "Web search is currently unavailable.", sources: [] };
  }
}
