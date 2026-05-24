export type TranscriptLine = {
  id: string;
  ts: string;
  speaker: string;
  text: string;
  isFinal: boolean;
};

export type Suggestion = {
  id: string;
  kind: "shop" | "search" | "map" | "calendar" | "info";
  title: string;
  description: string;
  url: string;
  actionLabel: string;
  createdAt: number;
};
