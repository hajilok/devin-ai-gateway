import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { pino, type Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type AppConfig } from "./config.js";
import { DevinClient } from "./devin/client.js";
import { bearerAuth } from "./middleware/auth.js";
import { chatCompletionsHandler } from "./routes/chatCompletions.js";
import { HttpError } from "./utils/errors.js";

export interface CreateAppOptions {
  config: AppConfig;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional logger override for tests. */
  logger?: Logger;
}

export function createApp(opts: CreateAppOptions): Express {
  const { config } = opts;
  const logger =
    opts.logger ??
    pino({
      level: config.logLevel,
      // Pretty output is intentionally avoided to keep prod-friendly JSON logs.
    });

  const client = new DevinClient({
    baseUrl: config.devinApiBase,
    apiKey: config.devinApiKey,
    fetchImpl: opts.fetchImpl,
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(
    pinoHttp({
      logger,
      // Avoid logging healthchecks at info level
      customLogLevel: (req: IncomingMessage, res: ServerResponse, err?: Error) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        if (req.url === "/healthz") return "debug";
        return "info";
      },
    })
  );

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Auth applies to all /v1 routes only.
  const v1 = express.Router();
  v1.use(bearerAuth(config.gatewayApiKey));

  v1.get("/models", (_req, res) => {
    res.json({
      object: "list",
      data: [
        {
          id: "devin",
          object: "model",
          created: 0,
          owned_by: "cognition-ai",
        },
      ],
    });
  });

  v1.post("/chat/completions", chatCompletionsHandler({ config, client, logger }));

  app.use("/v1", v1);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: {
        message: `Route not found: ${req.method} ${req.path}`,
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Centralized error handler — keep signature with 4 args so Express recognizes it.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      req.log?.warn({ err, status: err.status }, "request failed with HttpError");
      res.status(err.status).json(err.toBody());
      return;
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    req.log?.error({ err }, "unhandled error");
    res.status(500).json({
      error: { message, type: "internal_error" },
    });
  });

  return app;
}
