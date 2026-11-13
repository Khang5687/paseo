import { describe, expect, it } from "vitest";
import { resolveAgentTaskUrl } from "./agent-task-link";

describe("resolveAgentTaskUrl", () => {
  it("returns an https URL from the task-url label", () => {
    expect(resolveAgentTaskUrl({ "task-url": " https://example.com/#task/t1 " })).toBe(
      "https://example.com/#task/t1",
    );
  });

  it("returns null when the label is missing or not http(s)", () => {
    expect(resolveAgentTaskUrl(undefined)).toBeNull();
    expect(resolveAgentTaskUrl({})).toBeNull();
    expect(resolveAgentTaskUrl({ "task-url": "javascript:alert(1)" })).toBeNull();
    expect(resolveAgentTaskUrl({ "task-url": "not a url" })).toBeNull();
  });
});
