import { describe, expect, it } from "vitest";
import request from "supertest";
import { pino } from "pino";

import { createApp } from "../src/server.js";
import type { AppConfig } from "../src/config.js";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface MockBehavior {
  /** Number of times getSession has been polled. */
  polls: number;
  /** Captured calls in chronological order. */
  calls: CapturedCall[];
  /** How many polls before the session reports `finished`. */
  finishAfter: number;
  /** The Devin session_id to return. */
  sessionId: string;
  /** Final structured_output / message content. */
  finalMessage: string;
}

function makeFetchMock(behavior: MockBehavior): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const k of Object.keys(rawHeaders)) headers[k.toLowerCase()] = rawHeaders[k];
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    behavior.calls.push({ url, method, headers, body });

    if (method === "POST" && url.endsWith("/v1/sessions")) {
      return jsonResponse(200, {
        session_id: behavior.sessionId,
        url: `https://app.devin.ai/sessions/${behavior.sessionId}`,
        is_new_session: true,
      });
    }

    if (method === "GET" && url.includes(`/v1/sessions/${behavior.sessionId}`)) {
      behavior.polls += 1;
      const isLast = behavior.polls >= behavior.finishAfter;
      return jsonResponse(200, {
        session_id: behavior.sessionId,
        status_enum: isLast ? "finished" : "working",
        status: isLast ? "finished" : "working",
        url: `https://app.devin.ai/sessions/${behavior.sessionId}`,
        messages: isLast
          ? [
              { type: "user_message", message: "do the thing" },
              { type: "devin_message", message: behavior.finalMessage },
            ]
          : [{ type: "user_message", message: "do the thing" }],
        structured_output: null,
      });
    }

    return jsonResponse(404, { error: "not_found", url, method });
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    devinApiKey: "test-devin-key",
    devinApiBase: "https://api.devin.ai",
    devinPollIntervalMs: 1,
    devinPollTimeoutMs: 5000,
    gatewayApiKey: "",
    logLevel: "silent",
    ...overrides,
  };
}

const silentLogger = pino({ level: "silent" });

describe("POST /v1/chat/completions", () => {
  it("creates a Devin session, polls until finished, and returns OpenAI-shaped JSON", async () => {
    const behavior: MockBehavior = {
      polls: 0,
      calls: [],
      finishAfter: 2,
      sessionId: "devin-session-xyz",
      finalMessage: "All done. Tests pass.",
    };

    const app = createApp({
      config: baseConfig(),
      fetchImpl: makeFetchMock(behavior),
      logger: silentLogger,
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send({
        model: "devin",
        messages: [{ role: "user", content: "Run the test suite." }],
      });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("chat.completion");
    expect(res.body.id).toMatch(/^chatcmpl-/);
    expect(res.body.model).toBe("devin");
    expect(res.body.choices?.[0]?.message?.content).toBe("All done. Tests pass.");
    expect(res.body.choices?.[0]?.finish_reason).toBe("stop");
    expect(res.body.x_devin_session_id).toBe("devin-session-xyz");

    // Verify upstream calls used the configured Devin key.
    const post = behavior.calls.find((c) => c.method === "POST");
    expect(post?.headers["authorization"]).toBe("Bearer test-devin-key");
    expect(post?.body).toEqual({ prompt: "Run the test suite." });
    // We polled at least twice (status: working -> finished).
    expect(behavior.polls).toBeGreaterThanOrEqual(2);
  });

  it("rejects requests without bearer token when GATEWAY_API_KEY is set", async () => {
    const behavior: MockBehavior = {
      polls: 0,
      calls: [],
      finishAfter: 1,
      sessionId: "should-not-be-called",
      finalMessage: "nope",
    };

    const app = createApp({
      config: baseConfig({ gatewayApiKey: "secret-token" }),
      fetchImpl: makeFetchMock(behavior),
      logger: silentLogger,
    });

    const unauth = await request(app)
      .post("/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(unauth.status).toBe(401);
    expect(unauth.body.error?.type).toBe("invalid_request_error");
    expect(behavior.calls).toHaveLength(0);

    const ok = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", "Bearer secret-token")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(ok.status).toBe(200);
    expect(ok.body.choices?.[0]?.message?.content).toBe("nope");
  });

  it("returns 400 when messages is missing or empty", async () => {
    const app = createApp({
      config: baseConfig(),
      fetchImpl: makeFetchMock({
        polls: 0,
        calls: [],
        finishAfter: 1,
        sessionId: "x",
        finalMessage: "x",
      }),
      logger: silentLogger,
    });

    const res = await request(app).post("/v1/chat/completions").send({ model: "devin" });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("invalid_messages");
  });

  it("returns 400 when stream=true is requested", async () => {
    const app = createApp({
      config: baseConfig(),
      fetchImpl: makeFetchMock({
        polls: 0,
        calls: [],
        finishAfter: 1,
        sessionId: "x",
        finalMessage: "x",
      }),
      logger: silentLogger,
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .send({ stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("stream_not_supported");
  });

  it("returns 400 invalid_request_error when the request body is malformed JSON", async () => {
    const behavior: MockBehavior = {
      polls: 0,
      calls: [],
      finishAfter: 1,
      sessionId: "x",
      finalMessage: "x",
    };
    const app = createApp({
      config: baseConfig(),
      fetchImpl: makeFetchMock(behavior),
      logger: silentLogger,
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send("{bad json");

    expect(res.status).toBe(400);
    expect(res.body.error?.type).toBe("invalid_request_error");
    expect(res.body.error?.code).toBe("invalid_json");
    // The upstream Devin client must never have been called for a body parse error.
    expect(behavior.calls).toHaveLength(0);
  });
});

describe("misc routes", () => {
  it("GET /healthz returns ok", async () => {
    const app = createApp({
      config: baseConfig(),
      fetchImpl: makeFetchMock({
        polls: 0,
        calls: [],
        finishAfter: 1,
        sessionId: "x",
        finalMessage: "x",
      }),
      logger: silentLogger,
    });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /v1/models returns a static list", async () => {
    const app = createApp({
      config: baseConfig(),
      fetchImpl: makeFetchMock({
        polls: 0,
        calls: [],
        finishAfter: 1,
        sessionId: "x",
        finalMessage: "x",
      }),
      logger: silentLogger,
    });
    const res = await request(app).get("/v1/models");
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.data?.[0]?.id).toBe("devin");
  });
});
