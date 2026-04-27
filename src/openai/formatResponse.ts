import type { DevinSession, DevinSessionMessage } from "../devin/types.js";
import { newChatCompletionId, unixSeconds } from "../utils/ids.js";

export type FinishReason = "stop" | "length" | "content_filter";

export interface OpenAIChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: FinishReason;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  // Non-standard helpers, prefixed with `x_` so OpenAI-strict clients ignore them.
  x_devin_session_id?: string;
  x_devin_session_url?: string;
}

const TERMINAL_DEVIN_STATUSES = new Set([
  "finished",
  "blocked",
  "expired",
  "stopped",
]);

export function isTerminalStatus(status: string | undefined | null): boolean {
  if (!status) return false;
  return TERMINAL_DEVIN_STATUSES.has(status.toLowerCase());
}

function isAgentMessage(msg: DevinSessionMessage): boolean {
  // Devin v1 returns messages with a `type`/`origin` we look at heuristically.
  // `devin_message` and `agent_message` are the most common; fall back to any
  // message that is not clearly user-authored.
  const type = (msg.type ?? "").toString().toLowerCase();
  const origin = (msg.origin ?? msg.author ?? msg.role ?? "").toString().toLowerCase();
  if (type.includes("user") || origin === "user") return false;
  if (type.includes("devin") || type.includes("agent")) return true;
  if (origin.includes("devin") || origin.includes("agent") || origin === "assistant") return true;
  // If we can't tell, treat as agent so we still surface something useful.
  return type !== "" || origin !== "";
}

function pickMessageText(msg: DevinSessionMessage): string {
  if (typeof msg.message === "string" && msg.message.trim()) return msg.message.trim();
  if (typeof msg.content === "string" && msg.content.trim()) return msg.content.trim();
  if (typeof msg.text === "string" && msg.text.trim()) return msg.text.trim();
  return "";
}

/**
 * Determine the best textual answer for the OpenAI-style response, preferring
 * (in order): structured_output -> last agent message -> status fallback.
 */
export function extractFinalContent(session: DevinSession): string {
  if (session.structured_output != null) {
    if (typeof session.structured_output === "string") return session.structured_output;
    try {
      return JSON.stringify(session.structured_output, null, 2);
    } catch {
      // fall through
    }
  }

  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || !isAgentMessage(m)) continue;
    const text = pickMessageText(m);
    if (text) return text;
  }

  const status = session.status_enum ?? session.status ?? "unknown";
  const url = session.url ?? `https://app.devin.ai/sessions/${session.session_id ?? ""}`;
  return `Devin session ended with status "${status}" but produced no textual output. See ${url}`;
}

export interface FormatOptions {
  model: string;
  finishReason?: FinishReason;
}

export function formatChatCompletion(
  session: DevinSession,
  opts: FormatOptions
): OpenAIChatCompletionResponse {
  const content = extractFinalContent(session);
  const status = (session.status_enum ?? session.status ?? "").toLowerCase();
  const finishReason: FinishReason =
    opts.finishReason ?? (status === "expired" ? "length" : "stop");

  const sessionId = session.session_id ?? "";
  const url = session.url ?? (sessionId ? `https://app.devin.ai/sessions/${sessionId}` : undefined);

  const response: OpenAIChatCompletionResponse = {
    id: newChatCompletionId(),
    object: "chat.completion",
    created: unixSeconds(),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  if (sessionId) response.x_devin_session_id = sessionId;
  if (url) response.x_devin_session_url = url;

  return response;
}
