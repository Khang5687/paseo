import { describe, expect, it } from "vitest";

import {
  applySlashArgumentReplacement,
  applySlashCommandReplacement,
  filterAndRankCommandAutocompleteEntries,
  filterInlineSkillCommandEntries,
  filterSlashArgumentChoices,
  findActiveSlashArgument,
  findActiveSlashCommand,
} from "./agent-command-autocomplete";

describe("filterAndRankCommandAutocompleteEntries", () => {
  const entries = [
    { source: "provider" as const, command: { name: "paseo-committee" } },
    { source: "provider" as const, command: { name: "commit" } },
    { source: "provider" as const, command: { name: "paseo-advisor" } },
  ];

  it("ranks command-name prefixes above later word-boundary partial matches", () => {
    const result = filterAndRankCommandAutocompleteEntries(entries, "comm");

    expect(result.map((entry) => entry.command.name)).toEqual(["commit", "paseo-committee"]);
  });

  it("matches client command aliases", () => {
    const result = filterAndRankCommandAutocompleteEntries(
      [
        { source: "client" as const, command: { name: "exit", aliases: ["quit", "q"] } },
        { source: "client" as const, command: { name: "clear", aliases: ["new"] } },
      ],
      "q",
    );

    expect(result.map((entry) => entry.command.name)).toEqual(["exit"]);
  });
});

describe("findActiveSlashCommand", () => {
  it("detects a slash command token in the middle of the prompt", () => {
    const text = "use /tas before implementation";

    expect(
      findActiveSlashCommand({
        text,
        cursorIndex: "use /tas".length,
      }),
    ).toEqual({
      start: 4,
      end: "use /tas".length,
      query: "tas",
      position: "inline",
    });
  });

  it("classifies a slash command token at the prompt start", () => {
    expect(
      findActiveSlashCommand({
        text: "/rew",
        cursorIndex: "/rew".length,
      }),
    ).toEqual({
      start: 0,
      end: "/rew".length,
      query: "rew",
      position: "start",
    });
  });

  it("returns null when the cursor is outside the slash token", () => {
    expect(
      findActiveSlashCommand({
        text: "use /taste now",
        cursorIndex: "use /taste now".length,
      }),
    ).toBeNull();
  });

  it("returns null for slash-delimited paths", () => {
    expect(
      findActiveSlashCommand({
        text: "read /tmp/project",
        cursorIndex: "read /tmp/project".length,
      }),
    ).toBeNull();
  });
});

describe("applySlashCommandReplacement", () => {
  it("replaces only the active slash token", () => {
    const text = "use /tas before implementation";

    expect(
      applySlashCommandReplacement({
        text,
        command: { start: 4, end: "use /tas".length, query: "tas", position: "inline" },
        commandName: "taste",
      }),
    ).toBe("use /taste before implementation");
  });

  it("commits an inline slash token at the prompt tail", () => {
    const text = "use /tas";

    expect(
      applySlashCommandReplacement({
        text,
        command: { start: 4, end: text.length, query: "tas", position: "inline" },
        commandName: "taste",
      }),
    ).toBe("use /taste ");
  });

  it("commits a start slash token at the prompt tail", () => {
    const text = "/tas";

    expect(
      applySlashCommandReplacement({
        text,
        command: { start: 0, end: text.length, query: "tas", position: "start" },
        commandName: "taste",
      }),
    ).toBe("/taste ");
  });
});

describe("filterInlineSkillCommandEntries", () => {
  it("keeps provider skills and drops executable commands", () => {
    const entries = [
      { source: "client" as const, command: { name: "clear", kind: "command" } },
      { source: "provider" as const, command: { name: "compact", kind: "command" } },
      { source: "provider" as const, command: { name: "taste", kind: "skill" } },
    ];

    expect(filterInlineSkillCommandEntries(entries).map((entry) => entry.command.name)).toEqual([
      "taste",
    ]);
  });
});

describe("findActiveSlashArgument", () => {
  it("finds the first argument once the command name is followed by a space", () => {
    expect(findActiveSlashArgument({ text: "/compact ", cursorIndex: 9 })).toEqual({
      commandName: "compact",
      start: 9,
      end: 9,
      query: "",
    });
    expect(findActiveSlashArgument({ text: "/compact sn", cursorIndex: 11 })).toEqual({
      commandName: "compact",
      start: 9,
      end: 11,
      query: "sn",
    });
  });

  it("covers the whole token when the cursor is inside it", () => {
    expect(findActiveSlashArgument({ text: "/compact snapcompact", cursorIndex: 11 })).toEqual({
      commandName: "compact",
      start: 9,
      end: 20,
      query: "sn",
    });
  });

  it("ignores later arguments, inline commands, bare names and other lines", () => {
    const misses = [
      { text: "/compact soft focus", cursorIndex: 19 },
      { text: "/compact soft ", cursorIndex: 14 },
      { text: "please /compact ", cursorIndex: 16 },
      { text: "/compact", cursorIndex: 8 },
      { text: "/compact\nsoft", cursorIndex: 13 },
      { text: " /compact ", cursorIndex: 10 },
    ];
    for (const input of misses) {
      expect(findActiveSlashArgument(input)).toBeNull();
    }
  });
});

describe("filterSlashArgumentChoices", () => {
  const choices = [{ name: "soft" }, { name: "remote" }, { name: "snapcompact" }];

  it("keeps choices that start with the typed prefix, in their given order", () => {
    expect(filterSlashArgumentChoices(choices, "")).toEqual(choices);
    expect(filterSlashArgumentChoices(choices, "S")).toEqual([
      { name: "soft" },
      { name: "snapcompact" },
    ]);
    expect(filterSlashArgumentChoices(choices, "pact")).toEqual([]);
  });
});

describe("applySlashArgumentReplacement", () => {
  it("fills in the choice and a space at the end of the text", () => {
    const text = "/compact sn";
    const argument = findActiveSlashArgument({ text, cursorIndex: text.length });
    if (!argument) throw new Error("expected an argument");

    expect(applySlashArgumentReplacement({ text, argument, value: "snapcompact" })).toBe(
      "/compact snapcompact ",
    );
  });

  it("replaces the whole token and keeps the rest of the text", () => {
    const text = "/compact rem keep tests";
    const argument = findActiveSlashArgument({ text, cursorIndex: 10 });
    if (!argument) throw new Error("expected an argument");

    expect(applySlashArgumentReplacement({ text, argument, value: "soft" })).toBe(
      "/compact soft keep tests",
    );
  });
});
