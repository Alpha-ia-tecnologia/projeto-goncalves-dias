export type Gesture = "wave" | "nod" | "none";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  message: string;
  history?: ChatMessage[];
}

export interface ChatResponse {
  text: string;
  gesture: Gesture;
  provider: "deepseek";
}

export interface ServiceStatus {
  deepseek: boolean;
  openai: boolean;
  model: string;
  voice: string;
  mode: "live" | "demo";
}

export interface ApiErrorResponse {
  error: { code: string; message: string };
}

export const VOICES = [
  "cedar", "marin", "alloy", "ash", "ballad", "coral", "echo",
  "fable", "nova", "onyx", "sage", "shimmer", "verse",
] as const;

export type Voice = (typeof VOICES)[number];
