import { describe, expect, test } from "vitest";
import { applyDraftSet, releasedUploadIds } from "./agent-draft-service.js";
import type { StoredAgentDraftFields } from "../agent/agent-storage.js";

const DAY = 24 * 60 * 60 * 1000;
const policy = { now: 10 * DAY, retentionMs: 7 * DAY };

function set(
  fields: StoredAgentDraftFields,
  text: string,
  extra: Partial<{ clientId: string }> = {},
) {
  return applyDraftSet(
    fields,
    {
      text,
      attachments: [],
      updatedAt: policy.now,
      baseRevision: fields.draft?.revision ?? null,
      clientId: extra.clientId ?? "mac",
    },
    policy,
  );
}

describe("applyDraftSet", () => {
  test("snapshots when the box is emptied or loses more than half its text", () => {
    const long = set({}, "please refactor the session store into smaller modules").fields;
    expect(set(long, "").fields.draftHistory?.[0]?.text).toBe(long.draft?.text);
    expect(set(long, "please").fields.draftHistory?.[0]?.text).toBe(long.draft?.text);
    expect(set(long, "please refactor the session store into modules").fields.draftHistory).toEqual(
      [],
    );
  });

  test("ignores small shrinks of short drafts", () => {
    expect(set(set({}, "hello there").fields, "he").fields.draftHistory).toEqual([]);
  });

  test("drops snapshots past the retention window and keeps at most ten", () => {
    let fields: StoredAgentDraftFields = {
      draftHistory: [{ id: "old", createdAt: policy.now - 8 * DAY, text: "old", attachments: [] }],
    };
    for (let i = 0; i < 12; i++) fields = set(set(fields, `draft number ${i}`).fields, "").fields;
    expect(fields.draftHistory).toHaveLength(10);
    expect(fields.draftHistory?.some((snapshot) => snapshot.id === "old")).toBe(false);
    expect(fields.draftHistory?.[0]?.text).toBe("draft number 11");
  });

  test("keeps file uploads that went out with a sent message", () => {
    const file = { kind: "file", uploadId: "upload_f", value: {} };
    const before: StoredAgentDraftFields = {
      draft: { text: "", attachments: [file], revision: 1, updatedAt: 0, updatedBy: "mac" },
    };
    const after = applyDraftSet(
      before,
      {
        text: "",
        attachments: [],
        updatedAt: policy.now,
        baseRevision: 1,
        reason: "sent",
        clientId: "mac",
      },
      policy,
    ).fields;
    expect(after.sentDraftUploadIds).toEqual(["upload_f"]);
    expect(releasedUploadIds(before, { ...after, draftHistory: [] })).toEqual([]);
  });
});
