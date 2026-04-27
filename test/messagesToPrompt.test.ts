import { describe, expect, it } from "vitest";
import { messagesToPrompt } from "../src/openai/messagesToPrompt.js";

describe("messagesToPrompt", () => {
  it("returns user content verbatim for a single user message", () => {
    const prompt = messagesToPrompt([
      { role: "user", content: "Refactor file X to use async/await." },
    ]);
    expect(prompt).toBe("Refactor file X to use async/await.");
  });

  it("formats multi-role conversation with [role] headers", () => {
    const prompt = messagesToPrompt([
      { role: "system", content: "You are a careful coding agent." },
      { role: "user", content: "Add tests for utils/sum.ts" },
      { role: "assistant", content: "Sure, here is a plan..." },
      { role: "user", content: "Go ahead." },
    ]);
    expect(prompt).toBe(
      [
        "[system]\nYou are a careful coding agent.",
        "[user]\nAdd tests for utils/sum.ts",
        "[assistant]\nSure, here is a plan...",
        "[user]\nGo ahead.",
      ].join("\n\n")
    );
  });

  it("extracts text parts from multimodal content arrays and ignores images", () => {
    const prompt = messagesToPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this screenshot." },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ],
      },
    ]);
    expect(prompt).toBe("Describe this screenshot.");
  });

  it("throws on empty messages array", () => {
    expect(() => messagesToPrompt([])).toThrow(/non-empty/);
  });

  it("throws when no message has any text content", () => {
    expect(() =>
      messagesToPrompt([{ role: "user", content: [{ type: "image_url", image_url: "x" }] }])
    ).toThrow(/text part/);
  });

  it("trims whitespace and skips null content", () => {
    const prompt = messagesToPrompt([
      { role: "system", content: "  Be concise.  " },
      { role: "user", content: null },
      { role: "user", content: "Hello" },
    ]);
    expect(prompt).toBe("[system]\nBe concise.\n\n[user]\nHello");
  });
});
