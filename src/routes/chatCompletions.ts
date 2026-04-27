import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type { DevinClient } from "../devin/client.js";
import type { DevinSession, DevinSessionMessage } from "../devin/types.js";
import { pollUntilDone } from "../devin/poll.js";
import { messagesToPrompt, type OpenAIChatMessage } from "../openai/messagesToPrompt.js";
import {
  extractFinalContent,
  formatChatCompletion,
  isAgentMessage,
  pickMessageText,
  type FinishReason,
} from "../openai/formatResponse.js";
import { buildChunk, SseWriter } from "../openai/streamResponse.js";
import { newChatCompletionId, unixSeconds } from "../utils/ids.js";
import { badRequest } from "../utils/errors.js";

export interface ChatCompletionsDeps {
  config: AppConfig;
  client: DevinClient;
  logger: Logger;
}

interface ChatCompletionsBody {
  model?: string;
  messages?: OpenAIChatMessage[];
  stream?: boolean;
  // The remaining OpenAI knobs are accepted but ignored for MVP.
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  n?: number;
  [key: string]: unknown;
}

export function chatCompletionsHandler(deps: ChatCompletionsDeps): RequestHandler {
  const { config, client, logger } = deps;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as ChatCompletionsBody;

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw badRequest("`messages` must be a non-empty array.", "invalid_messages");
      }

      const model = (typeof body.model === "string" && body.model.trim()) || "devin";
      const stream = body.stream === true;

      let prompt: string;
      try {
        prompt = messagesToPrompt(body.messages);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to build prompt from messages.";
        throw badRequest(msg, "invalid_messages");
      }

      // Keep info logs free of user content; the truncated preview only goes
      // to debug to avoid leaking prompts/tasks into production log streams.
      logger.info(
        { model, prompt_length: prompt.length, stream },
        "creating Devin session"
      );
      logger.debug(
        { model, prompt_preview: prompt.slice(0, 200), prompt_length: prompt.length },
        "Devin session prompt preview"
      );

      if (stream) {
        await handleStreaming({
          req,
          res,
          deps,
          model,
          prompt,
        });
        return;
      }

      // Non-streaming path: single JSON response after the session terminates.
      const created = await client.createSession(prompt);
      const sessionId = created.session_id;
      if (!sessionId) {
        throw badRequest("Devin API did not return a session_id", "upstream_invalid_response");
      }

      logger.info({ session_id: sessionId, url: created.url }, "Devin session created, polling");

      const { session, timedOut } = await pollUntilDone(client, sessionId, {
        intervalMs: config.devinPollIntervalMs,
        timeoutMs: config.devinPollTimeoutMs,
      });

      if (timedOut) {
        logger.warn(
          { session_id: sessionId, status: session.status_enum ?? session.status },
          "Devin session polling timed out"
        );
      }

      const response = formatChatCompletion(session, {
        model,
        finishReason: timedOut ? "length" : undefined,
      });

      // Make sure we surface the Devin URL even when the response shape didn't carry it.
      if (!response.x_devin_session_url && created.url) {
        response.x_devin_session_url = created.url;
      }
      if (!response.x_devin_session_id) {
        response.x_devin_session_id = sessionId;
      }

      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  };
}

interface StreamingArgs {
  req: Request;
  res: Response;
  deps: ChatCompletionsDeps;
  model: string;
  prompt: string;
}

/**
 * SSE streaming flow.
 *
 * Devin's REST API does not (yet) emit token-level events, so we approximate
 * streaming by polling the session and emitting an OpenAI-style chunk every
 * time a new agent message appears. The shape mirrors
 * `chat.completion.chunk` so any OpenAI-compatible client works unchanged.
 *
 * If session creation itself fails we surface a regular 4xx/5xx via `next(err)`
 * because no SSE bytes have been sent yet. Once headers are flushed we are
 * committed to the stream and propagate any later error as a final delta
 * chunk followed by `[DONE]` so the client never hangs.
 */
async function handleStreaming(args: StreamingArgs): Promise<void> {
  const { req, res, deps, model, prompt } = args;
  const { config, client, logger } = deps;

  // Create the session BEFORE writing any SSE bytes so upstream auth/quota
  // failures still produce a clean JSON error response.
  const created = await client.createSession(prompt);
  const sessionId = created.session_id;
  if (!sessionId) {
    throw badRequest("Devin API did not return a session_id", "upstream_invalid_response");
  }
  const sessionUrl =
    created.url ?? `https://app.devin.ai/sessions/${sessionId}`;

  logger.info(
    { session_id: sessionId, url: sessionUrl, stream: true },
    "Devin session created, streaming"
  );

  const id = newChatCompletionId();
  const created_ts = unixSeconds();
  const writer = new SseWriter(res);
  writer.start();

  // Initial chunk advertising the assistant role — matches OpenAI's behavior
  // and lets clients render an empty message bubble immediately.
  writer.writeChunk(
    buildChunk({
      id,
      created: created_ts,
      model,
      delta: { role: "assistant" },
      sessionId,
      sessionUrl,
    })
  );

  const abort = new AbortController();
  let clientDisconnected = false;
  const onClose = () => {
    clientDisconnected = true;
    abort.abort();
  };
  req.on("close", onClose);

  // Track which agent-message indices we've already streamed so each polling
  // tick only emits *new* content.
  const streamedIndices = new Set<number>();
  let streamedAnyContent = false;

  const emitNewMessages = (session: DevinSession): void => {
    if (writer.isClosed()) return;
    const messages: DevinSessionMessage[] = Array.isArray(session.messages)
      ? session.messages
      : [];
    for (let i = 0; i < messages.length; i++) {
      if (streamedIndices.has(i)) continue;
      streamedIndices.add(i);
      const msg = messages[i];
      if (!msg || !isAgentMessage(msg)) continue;
      const text = pickMessageText(msg);
      if (!text) continue;
      // Append a newline so consecutive agent messages render as separate
      // paragraphs in chat clients that concatenate deltas verbatim.
      const content = streamedAnyContent ? `\n${text}` : text;
      writer.writeChunk(
        buildChunk({ id, created: created_ts, model, delta: { content } })
      );
      streamedAnyContent = true;
    }
  };

  try {
    const { session, timedOut } = await pollUntilDone(client, sessionId, {
      intervalMs: config.devinPollIntervalMs,
      timeoutMs: config.devinPollTimeoutMs,
      signal: abort.signal,
      onSnapshot: async (snapshot) => {
        emitNewMessages(snapshot);
      },
    });

    if (clientDisconnected) {
      logger.info(
        { session_id: sessionId },
        "client disconnected mid-stream; abandoning Devin polling"
      );
      writer.abort();
      return;
    }

    if (timedOut) {
      logger.warn(
        { session_id: sessionId, status: session.status_enum ?? session.status },
        "Devin session polling timed out (streaming)"
      );
    }

    // Devin sometimes only surfaces the final answer via `structured_output`
    // (e.g. JSON mode). If we never streamed any content, fall back to
    // `extractFinalContent` which knows how to find the best textual answer.
    if (!streamedAnyContent) {
      const fallback = extractFinalContent(session);
      if (fallback) {
        writer.writeChunk(
          buildChunk({ id, created: created_ts, model, delta: { content: fallback } })
        );
        streamedAnyContent = true;
      }
    } else if (typeof session.structured_output === "string" && session.structured_output.trim()) {
      // Surface structured_output as a trailing delta when it adds info.
      writer.writeChunk(
        buildChunk({
          id,
          created: created_ts,
          model,
          delta: { content: `\n${session.structured_output.trim()}` },
        })
      );
    }

    const status = (session.status_enum ?? session.status ?? "").toLowerCase();
    const finishReason: FinishReason = timedOut
      ? "length"
      : status === "expired"
        ? "length"
        : "stop";

    writer.writeChunk(
      buildChunk({
        id,
        created: created_ts,
        model,
        delta: {},
        finishReason,
        sessionId,
        sessionUrl,
      })
    );
    writer.end();
  } catch (err) {
    if (clientDisconnected) {
      writer.abort();
      return;
    }
    const message =
      err instanceof Error ? err.message : "Upstream Devin error during streaming.";
    logger.error({ err, session_id: sessionId }, "streaming failed mid-flight");
    writer.writeChunk(
      buildChunk({
        id,
        created: created_ts,
        model,
        delta: { content: `\n[gateway error: ${message}]` },
        finishReason: "stop",
        sessionId,
        sessionUrl,
      })
    );
    writer.end();
  } finally {
    req.off("close", onClose);
  }
}
