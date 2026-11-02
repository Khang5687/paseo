import { describe, expect, it } from "vitest";

import { projectAgentMessages } from "./agent-messages/envelope.js";
import {
  buildAgentBranchNameSeed,
  buildAgentPrompt,
  renderPromptAttachmentAsText,
} from "./prompt-attachments.js";

describe("prompt attachments", () => {
  it("places fork history before the new user prompt", () => {
    const chatHistory = {
      type: "text" as const,
      mimeType: "text/plain",
      contextKind: "chat_history" as const,
      title: "Chat history",
      text: "<chat-history-summary>\nPrevious work\n</chat-history-summary>",
    };
    const issue = {
      type: "github_issue" as const,
      mimeType: "application/github-issue",
      number: 55,
      title: "Issue",
      url: "https://github.com/getpaseo/paseo/issues/55",
    };

    expect(
      buildAgentPrompt(
        "  Take a different approach  ",
        [{ data: "image-data", mimeType: "image/png" }],
        [issue, chatHistory],
      ),
    ).toEqual([
      chatHistory,
      { type: "text", text: "Take a different approach" },
      { type: "image", data: "image-data", mimeType: "image/png" },
      issue,
    ]);
  });

  it("introduces each referenced attachment with its inline label after the text", () => {
    const file = {
      type: "uploaded_file" as const,
      id: "f1",
      fileName: "notes.pdf",
      mimeType: "application/pdf",
      size: 10,
      path: "/tmp/uploads/notes.pdf",
    };
    const unreferenced = {
      type: "uploaded_file" as const,
      id: "f2",
      fileName: "other.txt",
      mimeType: "text/plain",
      size: 3,
      path: "/tmp/uploads/other.txt",
    };

    expect(
      buildAgentPrompt(
        "Compare [Image #1] with [File #2]",
        [
          { data: "first", mimeType: "image/png" },
          { data: "second", mimeType: "image/png" },
        ],
        [unreferenced, file],
        [
          { label: "Image #1", imageIndex: 0 },
          { label: "File #2", attachmentIndex: 1 },
          { label: "Image #9", imageIndex: 7 },
        ],
      ),
    ).toEqual([
      {
        type: "text",
        text: "Compare [Image #1] with [File #2]",
        placeholders: ["[Image #1]", "[File #2]"],
      },
      { type: "text", mimeType: "text/plain", text: "[Image #1]:" },
      { type: "image", data: "first", mimeType: "image/png" },
      { type: "image", data: "second", mimeType: "image/png" },
      unreferenced,
      { type: "text", mimeType: "text/plain", text: "[File #2]: /tmp/uploads/notes.pdf" },
    ]);
  });

  it("replays a labeled prompt as the text the user typed", () => {
    const typed = "Compare [Image #1] with [File #2]\n[Image #1]: the left side";
    const prompt = buildAgentPrompt(
      typed,
      [{ data: "first", mimeType: "image/png" }],
      [
        {
          type: "uploaded_file",
          id: "f1",
          fileName: "notes.pdf",
          mimeType: "application/pdf",
          size: 10,
          path: "/tmp/uploads/notes.pdf",
        },
      ],
      [
        { label: "Image #1", imageIndex: 0 },
        { label: "File #2", attachmentIndex: 0 },
      ],
    );
    if (!Array.isArray(prompt)) throw new Error("expected content blocks");
    // Provider history returns every text part of the turn, as Claude and OMP transcripts do.
    const replayed = prompt
      .flatMap((block) =>
        block.type === "image"
          ? []
          : [block.type === "text" ? block.text : renderPromptAttachmentAsText(block)],
      )
      .join("\n\n");

    expect(projectAgentMessages({ type: "user_message", text: replayed })).toEqual([
      { type: "user_message", text: typed },
    ]);
  });

  it("renders github_pr attachments as readable text", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "github_pr",
        mimeType: "application/github-pr",
        number: 123,
        title: "Fix race in worktree setup",
        url: "https://github.com/getpaseo/paseo/pull/123",
        body: "PR body",
        baseRefName: "main",
        headRefName: "fix/worktree-race",
      }),
    ).toContain("GitHub PR #123: Fix race in worktree setup");
  });

  it("renders GitLab change request attachments with MR numbering", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "forge_change_request",
        mimeType: "application/paseo-forge-change-request",
        forge: "gitlab",
        number: 123,
        title: "Fix race in worktree setup",
        url: "https://gitlab.com/getpaseo/paseo/-/merge_requests/123",
        body: "MR body",
        projectPath: "getpaseo/paseo",
        baseRefName: "main",
        headRefName: "fix/worktree-race",
      }),
    ).toContain("GitLab MR !123: Fix race in worktree setup");
  });

  it.each(["base", "uncommitted", "all"] as const)("renders %s reviews", (mode) => {
    expect(
      renderPromptAttachmentAsText({
        type: "review",
        mimeType: "application/paseo-review",
        cwd: "/tmp/repo",
        mode,
        baseRef: "main",
        comments: [
          {
            filePath: "src/index.ts",
            side: "new",
            lineNumber: 42,
            body: "Please guard this nullable value.",
            context: {
              hunkHeader: "@@ -40,3 +40,4 @@",
              targetLine: {
                oldLineNumber: null,
                newLineNumber: 42,
                type: "add",
                content: "const value = maybeNull.name;",
              },
              lines: [
                {
                  oldLineNumber: 41,
                  newLineNumber: 41,
                  type: "context",
                  content: "const before = true;",
                },
                {
                  oldLineNumber: null,
                  newLineNumber: 42,
                  type: "add",
                  content: "const value = maybeNull.name;",
                },
              ],
            },
          },
        ],
      }),
    ).toBe(
      [
        `Paseo review attachment (${mode})`,
        "CWD: /tmp/repo",
        "Base: main",
        "",
        "Comment 1: src/index.ts:new:42",
        "Please guard this nullable value.",
        "@@ -40,3 +40,4 @@",
        "  41 41  const before = true;",
        ">  - 42 +const value = maybeNull.name;",
      ].join("\n"),
    );
  });

  it("renders github_issue attachments as readable text", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "github_issue",
        mimeType: "application/github-issue",
        number: 55,
        title: "Issue",
        url: "https://github.com/getpaseo/paseo/issues/55",
      }),
    ).toContain("GitHub Issue #55: Issue");
  });

  it("renders text attachments as their client-provided prompt text", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "text",
        mimeType: "text/plain",
        title: "Browser element",
        text: "<browser-element>button.primary</browser-element>",
      }),
    ).toBe("<browser-element>button.primary</browser-element>");
  });

  it("renders uploaded file attachments as local file references", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "uploaded_file",
        id: "upload_req-upload",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 11,
        path: "/tmp/paseo/uploads/upload_req-upload/notes.txt",
      }),
    ).toBe(
      [
        "Uploaded file: notes.txt",
        "Path: /tmp/paseo/uploads/upload_req-upload/notes.txt",
        "MIME: text/plain",
        "Size: 11 bytes",
      ].join("\n"),
    );
  });

  it("returns undefined when firstAgentContext is empty", () => {
    expect(buildAgentBranchNameSeed(undefined)).toBeUndefined();
    expect(buildAgentBranchNameSeed({})).toBeUndefined();
    expect(buildAgentBranchNameSeed({ prompt: "   " })).toBeUndefined();
    expect(buildAgentBranchNameSeed({ attachments: [] })).toBeUndefined();
  });

  it("wraps prompt and rendered attachments as tagged naming input", () => {
    expect(
      buildAgentBranchNameSeed({
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 123,
            title: "Fix worktree naming",
            url: "https://github.com/getpaseo/paseo/pull/123",
            baseRefName: "main",
            headRefName: "fix/worktree-naming",
          },
        ],
      }),
    ).toBe(
      "<user-prompt>\nInvestigate flaky test\n</user-prompt>\n\n<attachments>\nGitHub PR #123: Fix worktree naming\nhttps://github.com/getpaseo/paseo/pull/123\nBase: main\nHead: fix/worktree-naming\n</attachments>",
    );
  });
});
