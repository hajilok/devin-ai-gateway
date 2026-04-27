import { describe, expect, it } from "vitest";
import {
  extractFinalContent,
  formatChatCompletion,
  isTerminalStatus,
} from "../src/openai/formatResponse.js";

describe("isTerminalStatus", () => {
  it("recognizes terminal statuses", () => {
    expect(isTerminalStatus("finished")).toBe(true);
    expect(isTerminalStatus("BLOCKED")).toBe(true);
    expect(isTerminalStatus("expired")).toBe(true);
    expect(isTerminalStatus("stopped")).toBe(true);
  });

  it("returns false for non-terminal / unknown statuses", () => {
    expect(isTerminalStatus("working")).toBe(false);
    expect(isTerminalStatus("resume_requested")).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
    expect(isTerminalStatus(null)).toBe(false);
  });
});

describe("extractFinalContent", () => {
  it("prefers structured_output (string) when present", () => {
    expect(
      extractFinalContent({
        session_id: "s1",
        status_enum: "finished",
        structured_output: "the answer",
      })
    ).toBe("the answer");
  });

  it("stringifies structured_output when it is an object", () => {
    expect(
      extractFinalContent({
        session_id: "s1",
        status_enum: "finished",
        structured_output: { answer: 42 },
      })
    ).toContain('"answer": 42');
  });

  it("falls back to last agent message", () => {
    expect(
      extractFinalContent({
        session_id: "s1",
        status_enum: "finished",
        messages: [
          { type: "user_message", message: "do the thing" },
          { type: "devin_message", message: "step 1" },
          { type: "devin_message", message: "step 2 final" },
        ],
      })
    ).toBe("step 2 final");
  });

  it("returns a status fallback when no usable text is available", () => {
    const out = extractFinalContent({
      session_id: "s1",
      status_enum: "blocked",
      messages: [],
    });
    expect(out).toMatch(/blocked/);
    expect(out).toMatch(/app\.devin\.ai\/sessions\/s1/);
  });
});

describe("formatChatCompletion", () => {
  it("produces an OpenAI Chat Completions shape", () => {
    const resp = formatChatCompletion(
      {
        session_id: "abc",
        status_enum: "finished",
        url: "https://app.devin.ai/sessions/abc",
        messages: [{ type: "devin_message", message: "done" }],
      },
      { model: "devin" }
    );

    expect(resp.object).toBe("chat.completion");
    expect(resp.id).toMatch(/^chatcmpl-/);
    expect(resp.model).toBe("devin");
    expect(resp.choices).toHaveLength(1);
    expect(resp.choices[0].message).toEqual({ role: "assistant", content: "done" });
    expect(resp.choices[0].finish_reason).toBe("stop");
    expect(resp.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(resp.x_devin_session_id).toBe("abc");
    expect(resp.x_devin_session_url).toBe("https://app.devin.ai/sessions/abc");
    expect(typeof resp.created).toBe("number");
  });

  it("uses finish_reason='length' when explicitly forced (timeout)", () => {
    const resp = formatChatCompletion(
      { session_id: "x", status_enum: "working", messages: [] },
      { model: "devin", finishReason: "length" }
    );
    expect(resp.choices[0].finish_reason).toBe("length");
  });

  it("maps expired status to length", () => {
    const resp = formatChatCompletion(
      { session_id: "x", status_enum: "expired", messages: [] },
      { model: "devin" }
    );
    expect(resp.choices[0].finish_reason).toBe("length");
  });
});
