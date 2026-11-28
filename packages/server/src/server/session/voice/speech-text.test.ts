import { describe, expect, test } from "vitest";

import { prepareTextForSpeech } from "./speech-text.js";

describe("prepareTextForSpeech", () => {
  test("replaces a fenced code block with the words Code block", () => {
    const text = "Here is the fix:\n```ts\nconst a = 1;\nconsole.log(a);\n```\nRun it again.";
    expect(prepareTextForSpeech(text)).toBe("Here is the fix:\nCode block.\nRun it again.");
  });

  test("says Code block once even when several blocks follow", () => {
    const text = "One:\n```\nfoo\n```\nTwo:\n~~~sh\nbar\n~~~\nDone.";
    const spoken = prepareTextForSpeech(text);
    expect(spoken.match(/Code block\./g)).toHaveLength(1);
    expect(spoken).not.toContain("foo");
    expect(spoken).not.toContain("bar");
    expect(spoken).toContain("Done.");
  });

  test("drops an unterminated fence to the end of the text", () => {
    expect(prepareTextForSpeech("Look:\n```js\nlet x = 1;\nlet y = 2;")).toBe("Look:\nCode block.");
  });

  test("does not end a fence at a shorter or different fence line", () => {
    const text = "```\nkeep out\n~~~\nstill code\n```\nafter";
    expect(prepareTextForSpeech(text)).toBe("Code block.\nafter");
  });

  test("keeps the words of inline code", () => {
    expect(prepareTextForSpeech("Rename `fooBar` to `bazQux` first.")).toBe(
      "Rename fooBar to bazQux first.",
    );
  });

  test("shortens absolute and home paths to the last segment", () => {
    expect(
      prepareTextForSpeech("I edited /home/k/git/paseo/packages/server/src/server/session.ts."),
    ).toBe("I edited session.ts.");
    expect(prepareTextForSpeech("See ~/notes/plan.md now")).toBe("See plan.md now");
    expect(prepareTextForSpeech("Open ./src/index.tsx")).toBe("Open index.tsx");
  });

  test("shortens a path inside inline code", () => {
    expect(prepareTextForSpeech("Check `packages/app/src/voice/voice-runtime.ts` please")).toBe(
      "Check voice-runtime.ts please",
    );
  });

  test("shortens relative paths that carry a file extension or a known root", () => {
    expect(prepareTextForSpeech("Changed src/app/index.ts and docs/notes/voice.")).toBe(
      "Changed index.ts and voice.",
    );
    expect(prepareTextForSpeech("Moved lib/util.js")).toBe("Moved util.js");
  });

  test("turns a path with a line number into a spoken line", () => {
    expect(prepareTextForSpeech("The bug is in /srv/app/lib/parse.ts:42:7, not elsewhere")).toBe(
      "The bug is in parse.ts line 42, not elsewhere",
    );
  });

  test("keeps the sentence punctuation that follows a path", () => {
    expect(prepareTextForSpeech("Did you mean /usr/local/bin/node?")).toBe("Did you mean node?");
  });

  test("shortens Windows paths", () => {
    expect(prepareTextForSpeech("Saved to C:\\Users\\k\\Documents\\report.pdf today")).toBe(
      "Saved to report.pdf today",
    );
  });

  test("leaves ordinary slash words and fractions alone", () => {
    const text = "Pick read/write, and/or yes/no. It runs 24/7 at 3/4 speed over TCP/IP.";
    expect(prepareTextForSpeech(text)).toBe(text);
  });

  test("reduces URLs to the host and Markdown links to their label", () => {
    expect(prepareTextForSpeech("Docs at https://www.example.com/a/b/c?x=1#top for you")).toBe(
      "Docs at example.com for you",
    );
    expect(prepareTextForSpeech("Read [the guide](https://example.com/guide/start) next")).toBe(
      "Read the guide next",
    );
  });

  test("returns an empty string when nothing speakable remains", () => {
    expect(prepareTextForSpeech("   \n  ")).toBe("");
  });

  test("leaves plain sentences untouched", () => {
    const text = "Tests pass. I will open the pull request next.";
    expect(prepareTextForSpeech(text)).toBe(text);
  });
});
