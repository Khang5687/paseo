import { describe, expect, it } from "vitest";
import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import { recognizeTextLinks } from "react-native-enriched-markdown/src/web/recognizeTextLinks";
import type { ASTNode } from "react-native-enriched-markdown/src/web/types";
import { classifyForResolution } from "@/assistant-file-links/resolver";
import { markdownLinkSource, prepareMarkdownSource } from "./source";

// Every way an agent names a file in a reply, rendered through the same recognition the web
// engine runs and resolved the way a click resolves it.
const ROOT = "/Users/me/project";

/** `<source>:<link text> -> <file path | lookup query | ignored>` for each link in `markdown`. */
async function fileMentions(markdown: string): Promise<string[]> {
  const prepared = prepareMarkdownSource(markdown, ROOT);
  const tree = recognizeTextLinks(
    await parseMarkdown(prepared.render(), { latexMath: false, hardSoftBreaks: true }),
    prepared.linkRecognition.text,
    prepared.linkRecognition.inlineCode,
  );
  const mentions: string[] = [];
  function collect(node: ASTNode) {
    if (node.type !== "Link") {
      node.children?.forEach(collect);
      return;
    }
    const url = String(node.attributes?.url);
    let sourceType: "markdown" | "inline-code" | "text" = "markdown";
    if (node.attributes?.recognizedLink === "true") {
      sourceType = node.children?.[0]?.type === "Code" ? "inline-code" : "text";
    }
    const resolution = classifyForResolution(markdownLinkSource(url, sourceType), {
      workspaceRoot: ROOT,
    });
    let opens: string;
    if (resolution.kind === "needsLookup") opens = `lookup ${resolution.ambiguousQuery}`;
    else if (resolution.value.kind === "file") {
      const { path, lineStart } = resolution.value.target;
      opens = lineStart ? `${path}:${lineStart}` : path;
    } else opens = resolution.value.kind;
    mentions.push(`${sourceType}:${url} -> ${opens}`);
  }
  collect(tree);
  return mentions;
}

describe("files the agent names open from the reply", () => {
  it.each<[string, string, string[]]>([
    [
      "a document path in inline code",
      "`records/wholesale/2026-09-25_order/contract_as-sent.pdf`",
      [
        "inline-code:records/wholesale/2026-09-25_order/contract_as-sent.pdf -> lookup records/wholesale/2026-09-25_order/contract_as-sent.pdf",
      ],
    ],
    [
      "documents, data, media and archives under a directory",
      "`data/export.csv` `img/a.JPG` `out/archive.tar.gz` `keys/id_rsa.pub` `notebooks/a.ipynb`",
      [
        "inline-code:data/export.csv -> lookup data/export.csv",
        "inline-code:img/a.JPG -> lookup img/a.JPG",
        "inline-code:out/archive.tar.gz -> lookup out/archive.tar.gz",
        "inline-code:keys/id_rsa.pub -> lookup keys/id_rsa.pub",
        "inline-code:notebooks/a.ipynb -> lookup notebooks/a.ipynb",
      ],
    ],
    [
      "a document path in prose",
      "See docs/report.pdf and records/q3/order/contract.pdf.",
      [
        "text:docs/report.pdf -> /Users/me/project/docs/report.pdf",
        "text:records/q3/order/contract.pdf -> /Users/me/project/records/q3/order/contract.pdf",
      ],
    ],
    [
      "a bare document name",
      "Open report.pdf or `invoice.xlsx`.",
      ["text:report.pdf -> lookup report.pdf", "inline-code:invoice.xlsx -> lookup invoice.xlsx"],
    ],
    [
      "a path alone in a fence",
      "Here it is:\n\n```\nrecords/q3/contract.pdf\n```\n\nThere are two mistakes.",
      ["inline-code:records/q3/contract.pdf -> lookup records/q3/contract.pdf"],
    ],
    [
      "several paths in a tilde fence",
      "~~~text\nsrc/a.ts\n/tmp/build.log\n~~~",
      ["inline-code:src/a.ts -> lookup src/a.ts", "inline-code:/tmp/build.log -> /tmp/build.log"],
    ],
    [
      "a path fence against a paragraph, in a list and in a quote",
      "Here:\n```\ndocs/a.md\n```\nThen.\n\n1. Open:\n   ```\n   docs/b.md\n   ```\n\n> ```\n> docs/c.md\n> ```",
      [
        "inline-code:docs/a.md -> lookup docs/a.md",
        "inline-code:docs/b.md -> lookup docs/b.md",
        "inline-code:docs/c.md -> lookup docs/c.md",
      ],
    ],
    [
      "home paths with spaces",
      "`~/Library/Application Support/Paseo/config.json` and `/Users/me/My Docs/final report.pdf`",
      [
        "inline-code:~/Library/Application Support/Paseo/config.json -> ~/Library/Application Support/Paseo/config.json",
        "inline-code:/Users/me/My Docs/final report.pdf -> /Users/me/My Docs/final report.pdf",
      ],
    ],
    [
      "home paths in prose and through $HOME",
      "Check ~/.zshrc and ./run.sh, then `$HOME/.ssh/config`.",
      [
        "text:~/.zshrc -> ~/.zshrc",
        "text:./run.sh -> /Users/me/project/run.sh",
        "inline-code:$HOME/.ssh/config -> ~/.ssh/config",
      ],
    ],
    [
      "files without an extension",
      "Edit the Makefile, `src/Dockerfile` and `.github/CODEOWNERS`.",
      [
        "text:Makefile -> lookup Makefile",
        "inline-code:src/Dockerfile -> lookup src/Dockerfile",
        "inline-code:.github/CODEOWNERS -> lookup .github/CODEOWNERS",
      ],
    ],
    [
      "dotfiles in prose",
      "Set it in .env.local and .npmrc.",
      ["text:.env.local -> lookup .env.local", "text:.npmrc -> lookup .npmrc"],
    ],
    [
      "folders",
      "`src/components/` and `packages/app/src`",
      [
        "inline-code:src/components/ -> lookup src/components",
        "inline-code:packages/app/src -> lookup packages/app/src",
      ],
    ],
    [
      "paths before sentence and Unicode punctuation",
      "In src/app.ts: fixed. See src/a.ts… and src/b.ts—then “src/c.ts” and 说明.md，done",
      [
        "text:src/app.ts -> /Users/me/project/src/app.ts",
        "text:src/a.ts -> /Users/me/project/src/a.ts",
        "text:src/b.ts -> /Users/me/project/src/b.ts",
        "text:src/c.ts -> /Users/me/project/src/c.ts",
        "text:说明.md -> lookup 说明.md",
      ],
    ],
    [
      "an authored link to a document",
      "[the contract](records/q3/contract.pdf)",
      ["markdown:records/q3/contract.pdf -> /Users/me/project/records/q3/contract.pdf"],
    ],
  ])("%s", async (_name, markdown, expected) => {
    expect(await fileMentions(markdown)).toEqual(expected);
  });

  it.each<[string, string]>([
    ["shell commands", "`/usr/bin/env python3 script.py` `~/bin/tool --flag x.ts` `cd ~/a && ls`"],
    ["a fence of commands", "```bash\ncat src/app.ts\n```"],
    ["a fence that mixes paths and notes", "```\nsrc/app.ts # entry\n```"],
    ["a fence of quoted paths", '```json\n"src/app.ts"\n```'],
    ["an unfinished fence", "```\ndocs/report.pdf"],
    ["a relative path with spaces", "`docs/My Notes.md`"],
    ["words with dots and slashes", "I/O.Read and/or 1/2.5x client/server ASP.NET .NET Profile"],
    ["capitalised words that name files only in code", "Read the README and NOTICE."],
  ])("leaves %s as text", async (_name, markdown) => {
    expect(await fileMentions(markdown)).toEqual([]);
  });
});
