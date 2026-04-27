import type { Response } from "express";
import type { FinishReason } from "./formatResponse.js";

/**
 * OpenAI-compatible chunk envelope sent over SSE while streaming a chat
 * completion. Each chunk carries an incremental `delta` rather than the full
 * message.
 *
 * Reference: https://platform.openai.com/docs/api-reference/chat/streaming
 */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: FinishReason | null;
  }>;
  // Non-standard helpers; OpenAI-strict clients ignore unknown fields.
  x_devin_session_id?: string;
  x_devin_session_url?: string;
}

export interface BuildChunkOptions {
  id: string;
  created: number;
  model: string;
  delta?: { role?: "assistant"; content?: string };
  finishReason?: FinishReason | null;
  sessionId?: string;
  sessionUrl?: string;
}

export function buildChunk(opts: BuildChunkOptions): ChatCompletionChunk {
  const chunk: ChatCompletionChunk = {
    id: opts.id,
    object: "chat.completion.chunk",
    created: opts.created,
    model: opts.model,
    choices: [
      {
        index: 0,
        delta: opts.delta ?? {},
        finish_reason: opts.finishReason ?? null,
      },
    ],
  };
  if (opts.sessionId) chunk.x_devin_session_id = opts.sessionId;
  if (opts.sessionUrl) chunk.x_devin_session_url = opts.sessionUrl;
  return chunk;
}

/**
 * Thin helper around an Express `Response` that knows how to write SSE frames
 * conforming to the OpenAI streaming protocol (each event is a single
 * `data: <json>` line, terminated by a blank line; the stream ends with the
 * sentinel `data: [DONE]`).
 *
 * The writer is defensive: once the underlying response is closed (by the
 * client disconnecting, an upstream error, or `end()` being called) further
 * `write` calls become no-ops so the rest of the handler can unwind cleanly
 * without throwing `ERR_STREAM_WRITE_AFTER_END`.
 */
export class SseWriter {
  private closed = false;

  constructor(private readonly res: Response) {}

  start(): void {
    if (this.closed) return;
    this.res.status(200);
    this.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    this.res.setHeader("Cache-Control", "no-cache, no-transform");
    this.res.setHeader("Connection", "keep-alive");
    // Hint to nginx/Cloud Run to disable response buffering.
    this.res.setHeader("X-Accel-Buffering", "no");
    // Flush headers immediately so the client receives the response prelude.
    this.res.flushHeaders?.();
  }

  writeChunk(chunk: ChatCompletionChunk): void {
    if (this.closed) return;
    const ok = this.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (ok === false) {
      // Backpressure: the underlying socket buffer is full. We do not block
      // here because Devin polling intervals are slow enough that the OS will
      // drain naturally before the next chunk; surfacing it would only make
      // the gateway look stuck to upstream clients.
    }
  }

  writeComment(text: string): void {
    if (this.closed) return;
    this.res.write(`: ${text}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.res.write("data: [DONE]\n\n");
    this.res.end();
    this.closed = true;
  }

  /** Mark the stream as closed without writing the [DONE] terminator. */
  abort(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.res.end();
    } catch {
      // ignore — the socket may already be torn down
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}
