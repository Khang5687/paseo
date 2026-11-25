import { describe, expect, it } from "vitest";
import { collectFileMentions } from "./index.js";

// Cases copied from the app's packages/app/src/components/markdown/file-mentions.test.ts and
// renderer.test.ts ("file mentions saved for offline use"). The app renders links; this module
// only collects what a turn names, so code fences never count here.
const ROOT = "/Users/me/project";

function mentions(markdown: string, workspaceRoot = ROOT): string[] {
  return collectFileMentions(markdown, { workspaceRoot })
    .map((mention) => (mention.kind === "path" ? mention.path : `lookup ${mention.ambiguousQuery}`))
    .sort();
}

describe("collectFileMentions", () => {
  it("collects prose, inline-code and linked paths but not code blocks or URLs", () => {
    const source = [
      "Edited /repo/src/app.ts and `/repo/README.md`.",
      "See [the plan](/repo/docs/plan.md) and https://example.com/a.ts.",
      "```ts",
      'import x from "/repo/src/hidden.ts";',
      "```",
    ].join("\n");
    expect(mentions(source, "/repo")).toEqual([
      "/repo/README.md",
      "/repo/docs/plan.md",
      "/repo/src/app.ts",
    ]);
  });

  it("keeps one lookup for a bare name named twice", () => {
    const found = collectFileMentions("Updated `notes.txt` twice: `notes.txt`.", {
      workspaceRoot: "/repo",
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "needsLookup", token: "notes.txt" });
  });

  it.each<[string, string, string[]]>([
    [
      "a document path in inline code",
      "`records/wholesale/2026-09-25_order/contract_as-sent.pdf`",
      ["lookup records/wholesale/2026-09-25_order/contract_as-sent.pdf"],
    ],
    [
      "a document path in prose",
      "See docs/report.pdf and records/q3/order/contract.pdf.",
      ["/Users/me/project/docs/report.pdf", "/Users/me/project/records/q3/order/contract.pdf"],
    ],
    [
      "a bare document name",
      "Open report.pdf or `invoice.xlsx`.",
      ["lookup invoice.xlsx", "lookup report.pdf"],
    ],
    [
      "home paths with spaces",
      "`~/Library/Application Support/Paseo/config.json` and `/Users/me/My Docs/final report.pdf`",
      ["/Users/me/My Docs/final report.pdf", "~/Library/Application Support/Paseo/config.json"],
    ],
    [
      "home paths in prose and through $HOME",
      "Check ~/.zshrc and ./run.sh, then `$HOME/.ssh/config`.",
      ["/Users/me/project/run.sh", "~/.ssh/config", "~/.zshrc"],
    ],
    [
      "files without an extension",
      "Edit the Makefile, `src/Dockerfile` and `.github/CODEOWNERS`.",
      ["lookup .github/CODEOWNERS", "lookup Makefile", "lookup src/Dockerfile"],
    ],
    [
      "dotfiles in prose",
      "Set it in .env.local and .npmrc.",
      ["lookup .env.local", "lookup .npmrc"],
    ],
    [
      "paths before sentence and Unicode punctuation",
      "In src/app.ts: fixed. See src/a.ts… and src/b.ts—then “src/c.ts” and 说明.md，done",
      [
        "/Users/me/project/src/a.ts",
        "/Users/me/project/src/app.ts",
        "/Users/me/project/src/b.ts",
        "/Users/me/project/src/c.ts",
        "lookup 说明.md",
      ],
    ],
    [
      "an authored link to a document",
      "[the contract](records/q3/contract.pdf)",
      ["/Users/me/project/records/q3/contract.pdf"],
    ],
  ])("collects %s", (_name, markdown, expected) => {
    expect(mentions(markdown)).toEqual(expected);
  });

  it.each<[string, string]>([
    ["shell commands", "`/usr/bin/env python3 script.py` `~/bin/tool --flag x.ts` `cd ~/a && ls`"],
    ["a fence of commands", "```bash\ncat src/app.ts\n```"],
    ["a fence that mixes paths and notes", "```\nsrc/app.ts # entry\n```"],
    ["a fence of quoted paths", '```json\n"src/app.ts"\n```'],
    ["an unfinished fence", "```\ndocs/report.pdf"],
    ["a path alone in a fence", "Here it is:\n\n```\nrecords/q3/contract.pdf\n```\n\nDone."],
    ["several paths in a tilde fence", "~~~text\nsrc/a.ts\n/tmp/build.log\n~~~"],
    ["a relative path with spaces", "`docs/My Notes.md`"],
    ["words with dots and slashes", "I/O.Read and/or 1/2.5x client/server ASP.NET .NET Profile"],
    ["capitalised words that name files only in code", "Read the README and NOTICE."],
    ["web addresses", "See https://example.com/a.ts and https://example.com/docs/x.md."],
  ])("ignores %s", (_name, markdown) => {
    expect(mentions(markdown)).toEqual([]);
  });
});
