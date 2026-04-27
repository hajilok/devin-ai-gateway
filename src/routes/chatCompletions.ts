import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type { DevinClient } from "../devin/client.js";
import { pollUntilDone } from "../devin/poll.js";
import { messagesToPrompt, type OpenAIChatMessage } from "../openai/messagesToPrompt.js";
import { formatChatCompletion } from "../openai/formatResponse.js";
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

      if (body.stream === true) {
        throw badRequest(
          "Streaming responses are not supported by this gateway yet. Set stream=false.",
          "stream_not_supported"
        );
      }

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw badRequest("`messages` must be a non-empty array.", "invalid_messages");
      }

      const model = (typeof body.model === "string" && body.model.trim()) || "devin";

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
        { model, prompt_length: prompt.length },
        "creating Devin session"
      );
      logger.debug(
        { model, prompt_preview: prompt.slice(0, 200), prompt_length: prompt.length },
        "Devin session prompt preview"
      );

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
