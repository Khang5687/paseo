import { describe, expect, test } from "vitest";

import {
  mapOmpAvailableCommandsUpdate,
  mapOmpSlashCommands,
  resolveOmpCompactRequest,
} from "./commands.js";

const COMPACT_MODES = [
  { name: "soft", description: "Summarize locally", usage: "[focus]" },
  { name: "remote", description: "Server compaction", usage: "[focus]" },
  { name: "snapcompact", description: "Archive history onto images" },
];

describe("OMP slash command mapper", () => {
  test("maps command updates and preserves input hints", () => {
    const commands = mapOmpAvailableCommandsUpdate({
      type: "available_commands_update",
      commands: [
        { name: "todo", description: "Manage todos", input: { hint: "<subcommand>" } },
        { name: "fast", description: "Toggle fast mode", input: { hint: "[on|off|status]" } },
        { name: "handoff", description: "Start a handoff" },
      ],
    });

    expect(commands?.find((command) => command.name === "todo")).toEqual({
      name: "todo",
      description: "Manage todos",
      argumentHint: "<subcommand>",
      kind: "command",
    });
    expect(commands?.find((command) => command.name === "fast")).toEqual({
      name: "fast",
      description: "Toggle fast mode",
      argumentHint: "[on|off|status]",
      kind: "command",
    });
    expect(commands?.find((command) => command.name === "handoff")).toEqual({
      name: "handoff",
      description: "Start a handoff",
      argumentHint: "[instructions]",
      kind: "command",
    });
  });

  test("maps source-attributed OMP 17 commands", () => {
    const commands = mapOmpAvailableCommandsUpdate({
      type: "available_commands_update",
      commands: [
        {
          name: "prewalk",
          description: "Prewalk at the next action",
          source: "builtin",
        },
      ],
    });

    expect(commands?.find((command) => command.name === "prewalk")).toEqual({
      name: "prewalk",
      description: "Prewalk at the next action",
      argumentHint: "",
      kind: "command",
    });
  });

  test("drops malformed command updates", () => {
    expect(
      mapOmpAvailableCommandsUpdate({ type: "available_commands_update", commands: [{}] }),
    ).toBeNull();
  });

  test("keeps OMP subcommand choices and aliases from both command sources", () => {
    const compact = {
      name: "compact",
      description: "Compact the conversation",
      source: "builtin",
      aliases: ["c"],
      input: { hint: "[soft|remote|snapcompact] [focus]" },
      subcommands: COMPACT_MODES,
    };
    const expected = {
      name: "compact",
      description: "Compact the conversation",
      argumentHint: "[soft|remote|snapcompact] [focus]",
      kind: "command",
      aliases: ["c"],
      subcommands: COMPACT_MODES,
    };

    const fromUpdate = mapOmpAvailableCommandsUpdate({
      type: "available_commands_update",
      commands: [compact],
    });
    const fromList = mapOmpSlashCommands([{ ...compact, sourceInfo: { path: "builtin" } }]);

    expect(fromUpdate?.find((command) => command.name === "compact")).toEqual(expected);
    expect(fromList.find((command) => command.name === "compact")).toEqual(expected);
  });

  test("gives Paseo-handled autocompact its choices and prefers OMP's when advertised", () => {
    const builtIn = mapOmpSlashCommands([]).find((command) => command.name === "autocompact");
    expect(builtIn?.subcommands?.map((choice) => choice.name)).toEqual(["on", "off", "toggle"]);

    const advertised = mapOmpSlashCommands([
      { name: "autocompact", subcommands: [{ name: "status", description: "Show state" }] },
    ]).find((command) => command.name === "autocompact");
    expect(advertised?.subcommands).toEqual([{ name: "status", description: "Show state" }]);
  });

  test("adds OMP-only out-of-band commands to handled built-ins", () => {
    expect(mapOmpSlashCommands([]).map((command) => command.name)).toEqual([
      "compact",
      "autocompact",
      "handoff",
      "steer",
      "follow-up",
    ]);
  });
});

describe("resolveOmpCompactRequest", () => {
  test("sends an advertised mode through OMP's /compact handler", () => {
    expect(resolveOmpCompactRequest("snapcompact", COMPACT_MODES)).toEqual({
      kind: "prompt",
      message: "/compact snapcompact",
    });
    expect(resolveOmpCompactRequest("SOFT  keep the API notes", COMPACT_MODES)).toEqual({
      kind: "prompt",
      message: "/compact soft keep the API notes",
    });
  });

  test("keeps focus text and plain compaction on the compact RPC", () => {
    expect(resolveOmpCompactRequest(undefined, COMPACT_MODES)).toEqual({ kind: "rpc" });
    expect(resolveOmpCompactRequest("softly keep tests", COMPACT_MODES)).toEqual({
      kind: "rpc",
      customInstructions: "softly keep tests",
    });
    // An OMP that advertises no modes treats every argument as focus text.
    expect(resolveOmpCompactRequest("snapcompact", [])).toEqual({
      kind: "rpc",
      customInstructions: "snapcompact",
    });
  });

  test("rejects focus text for a mode that takes none", () => {
    expect(resolveOmpCompactRequest("snapcompact keep tests", COMPACT_MODES)).toEqual({
      kind: "invalid",
      error: "/compact snapcompact does not take focus instructions.",
    });
  });
});
