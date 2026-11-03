import { describe, expect, it } from "vitest";
import { buildArchiveConfirmDialog } from "@/utils/archive-confirm";

describe("buildArchiveConfirmDialog", () => {
  it("names the agent and points at History", () => {
    expect(buildArchiveConfirmDialog({ subject: "agent", name: "  Fix login  " })).toEqual({
      title: "Archive “Fix login”?",
      message: "You can restore it from History.",
      confirmLabel: "Archive",
      cancelLabel: "Cancel",
      destructive: true,
    });
  });

  it("falls back to a generic title when the name is blank", () => {
    expect(buildArchiveConfirmDialog({ subject: "agent", name: " " }).title).toBe(
      "Archive this agent?",
    );
    expect(buildArchiveConfirmDialog({ subject: "workspace", name: null }).title).toBe(
      "Archive this workspace?",
    );
  });

  it("titles workspace and bulk archives", () => {
    expect(buildArchiveConfirmDialog({ subject: "workspace", name: "feat/x" }).title).toBe(
      "Archive workspace “feat/x”?",
    );
    expect(buildArchiveConfirmDialog({ subject: "finishedSubagents" }).title).toBe(
      "Archive finished subagents?",
    );
  });
});
