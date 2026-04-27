import type { DevinCreateSessionResponse, DevinSession } from "./types.js";
import { upstreamError } from "../utils/errors.js";

export interface DevinClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Allows tests to inject a fetch implementation. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Defaults to 30s. */
  requestTimeoutMs?: number;
}

export class DevinClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(opts: DevinClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      const parsed = text ? safeJson(text) : undefined;

      if (!res.ok) {
        const msg =
          (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).error) ||
          (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).message) ||
          text ||
          `Devin API responded with status ${res.status}`;
        throw upstreamError(
          typeof msg === "string" ? msg : JSON.stringify(msg),
          res.status >= 500 ? 502 : res.status
        );
      }

      return parsed as T;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw upstreamError(`Devin API request timed out after ${this.requestTimeoutMs}ms`, 504);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  createSession(prompt: string): Promise<DevinCreateSessionResponse> {
    return this.request<DevinCreateSessionResponse>("POST", "/v1/sessions", { prompt });
  }

  getSession(sessionId: string): Promise<DevinSession> {
    const id = encodeURIComponent(sessionId);
    return this.request<DevinSession>("GET", `/v1/sessions/${id}`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
