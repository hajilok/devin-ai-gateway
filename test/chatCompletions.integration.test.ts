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

interface MockOptions {
  /**
   * If provided, each progressive message becomes a `devin_message` that is
   * surfaced one poll earlier than the next one. The `finalMessage` is then
   * appended on the terminal poll.
   */
  progressiveMessages?: string[];
}

function makeFetchMock(behavior: MockBehavior, options: MockOptions = {}): typeof fetch {
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
      const progressive = options.progressiveMessages ?? [];
      const messages: Array<Record<string, unknown>> = [
        { type: "user_message", message: "do the thing" },
      ];
      // Surface progressive messages one-by-one across polls.
      const visibleProgressCount = Math.min(behavior.polls, progressive.length);
      for (let i = 0; i < visibleProgressCount; i++) {
        messages.push({ type: "devin_message", message: progressive[i] });
      }
      if (isLast) {
        messages.push({ type: "devin_message", message: behavior.finalMessage });
      }
      return jsonResponse(200, {
        session_id: behavior.sessionId,
        status_enum: isLast ? "finished" : "working",
        status: isLast ? "finished" : "working",
        url: `https://app.devin.ai/sessions/${behavior.sessionId}`,
        messages,
        structured_output: null,
      });
    }

    return jsonResponse(404, { error: "not_found", url, method });
  }) as unknown as typeof fetch;
}

/**
 * Parse a raw SSE response body into an ordered list of `data:` payloads.
 * The `[DONE]` sentinel and JSON payloads are returned as-is so callers can
 * choose to JSON.parse() the rest.
 */
function parseSseEvents(raw: string): string[] {
  const out: string[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    out.push(dataLines.join("\n"));
  }
  return out;
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

  it("streams an SSE response with chat.completion.chunk events when stream=true", async () => {
    const behavior: MockBehavior = {
      polls: 0,
      calls: [],
      finishAfter: 3,
      sessionId: "stream-session-1",
      finalMessage: "All done streaming.",
    };

    const app = createApp({
      config: baseConfig(),
      fetchImpl: makeFetchMock(behavior, {
        // Provide progressive agent messages on each poll so we can verify
        // incremental SSE chunks are emitted.
        progressiveMessages: [
          "Reading the repository...",
          "Running the test suite...",
        ],
      }),
      logger: silentLogger,
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .buffer(true)
      .send({
        model: "devin",
        stream: true,
        messages: [{ role: "user", content: "Run the test suite." }],
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(res.text).toContain("data: [DONE]");

    const events = parseSseEvents(res.text);
    // Last event must be the [DONE] sentinel.
    expect(events[events.length - 1]).toBe("[DONE]");

    const chunks: any[] = events.slice(0, -1).map((line: string) => JSON.parse(line));
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    for (const c of chunks) {
      expect(c.object).toBe("chat.completion.chunk");
      expect(c.id).toMatch(/^chatcmpl-/);
      expect(c.model).toBe("devin");
      expect(typeof c.created).toBe("number");
      expect(Array.isArray(c.choices)).toBe(true);
      expect(c.choices[0]?.index).toBe(0);
    }

    // First chunk announces the assistant role.
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" });
    expect(chunks[0].choices[0].finish_reason).toBeNull();

    // Some middle chunk(s) carry incremental content.
    const contentParts = chunks
      .map((c: any) => c.choices[0].delta.content)
      .filter((s: unknown): s is string => typeof s === "string");
    const combined = contentParts.join("");
    expect(combined).toContain("Reading the repository...");
    expect(combined).toContain("Running the test suite...");
    expect(combined).toContain("All done streaming.");

    // Final chunk closes with finish_reason="stop" and an empty delta.
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.choices[0].delta).toEqual({});
    expect(last.x_devin_session_id).toBe("stream-session-1");
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
