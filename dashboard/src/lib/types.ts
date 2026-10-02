export type TranscriptLine = {
  id: string;
  ts: string;
  speaker: string;
  text: string;
  isFinal: boolean;
};

export type Suggestion = {
  id: string;
  kind: "shop" | "search" | "map" | "calendar" | "info" | "agent";
  title: string;
  description: string;
  url: string;
  actionLabel: string;
  createdAt: number;
  /** For kind "agent": the imperative task the browser agent should execute. */
  task?: string;
};

export type MemoryType =
  | "preference"
  | "fact"
  | "person"
  | "place"
  | "plan"
  | "interest";

export type MemoryItem = {
  id: string;
  type: MemoryType;
  category: string;
  content: string;
  entities: string[];
  sourceText: string;
  salience: number;
  reinforcements: number;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
};

export type AgentRunStatus = "running" | "done" | "error" | "cancelled";

export type AgentStep = {
  n: number;
  kind: "thought" | "tool" | "observation" | "final" | "error";
  label: string;
  detail: string;
  createdAt: number;
};

export type AgentRun = {
  id: string;
  task: string;
  status: AgentRunStatus;
  result: string | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
};
