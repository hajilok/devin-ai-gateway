/**
 * OpenAI chat-style message types we care about. We accept the multimodal
 * `content` array (used by GPT-4o style clients) but only keep the `text`
 * parts since Devin sessions accept plain prompts.
 */
export type OpenAIRole = "system" | "user" | "assistant" | "tool" | "function";

export interface OpenAITextPart {
  type: "text";
  text: string;
}

export interface OpenAIImagePart {
  type: "image_url";
  image_url: { url: string } | string;
}

export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart | { type: string; [k: string]: unknown };

export interface OpenAIChatMessage {
  role: OpenAIRole;
  content: string | OpenAIContentPart[] | null;
  name?: string;
}

function extractText(content: OpenAIChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof (part as OpenAITextPart).text === "string") {
      texts.push((part as OpenAITextPart).text);
    }
    // image_url parts and unknown types are ignored for MVP.
  }
  return texts.join("\n").trim();
}

/**
 * Convert an OpenAI-style messages[] array into a single prompt string suitable
 * for Devin's `POST /v1/sessions { prompt }` body.
 *
 * Heuristics:
 *  - If only a single user message is present (no system / assistant), return
 *    its text verbatim. This keeps simple prompts clean.
 *  - Otherwise produce a labelled transcript using `[role]` headers so Devin
 *    has the full context.
 */
export function messagesToPrompt(messages: OpenAIChatMessage[]): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }

  const normalised = messages
    .map((m) => ({ role: m.role, text: extractText(m.content) }))
    .filter((m) => m.text.length > 0);

  if (normalised.length === 0) {
    throw new Error("messages must contain at least one non-empty text part");
  }

  if (normalised.length === 1 && normalised[0].role === "user") {
    return normalised[0].text.trim();
  }

  return normalised
    .map((m) => `[${m.role}]\n${m.text.trim()}`)
    .join("\n\n")
    .trim();
}
