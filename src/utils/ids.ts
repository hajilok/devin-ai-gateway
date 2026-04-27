import { randomUUID } from "node:crypto";

/**
 * Generate an OpenAI-style chat completion id, e.g. "chatcmpl-abc123...".
 * Uses crypto.randomUUID under the hood and strips dashes for compactness.
 */
export function newChatCompletionId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, "")}`;
}

/**
 * Current unix timestamp in seconds (OpenAI's `created` field convention).
 */
export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
