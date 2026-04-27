import type { DevinClient } from "./client.js";
import type { DevinSession } from "./types.js";
import { isTerminalStatus } from "../openai/formatResponse.js";

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Test seam for sleep. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for now(). Defaults to Date.now. */
  now?: () => number;
  /** Optional cancel signal. */
  signal?: AbortSignal;
}

export interface PollResult {
  session: DevinSession;
  timedOut: boolean;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll Devin's `GET /v1/sessions/{id}` until the session reaches a terminal
 * status (`finished`, `blocked`, `expired`, `stopped`) or the overall timeout
 * elapses. The most recent session payload is always returned, with a
 * `timedOut` flag telling the caller whether the wait was cut short.
 */
export async function pollUntilDone(
  client: DevinClient,
  sessionId: string,
  opts: PollOptions
): Promise<PollResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());

  const start = now();
  let last: DevinSession | undefined;

  while (true) {
    if (opts.signal?.aborted) {
      // Abort: return the latest snapshot if we have one, otherwise rethrow.
      if (last) return { session: last, timedOut: true };
      throw new Error("Polling aborted before any session snapshot was retrieved");
    }

    last = await client.getSession(sessionId);
    const status = last.status_enum ?? last.status;
    if (isTerminalStatus(status)) {
      return { session: last, timedOut: false };
    }

    const elapsed = now() - start;
    const remaining = opts.timeoutMs - elapsed;
    if (remaining <= 0) {
      return { session: last, timedOut: true };
    }

    await sleep(Math.min(opts.intervalMs, Math.max(remaining, 0)));
  }
}
