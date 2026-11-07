import { describe, expect, test } from "vitest";

import {
  mapOmpAvailableCommandsUpdate,
  mapOmpRuntimeSlashCommands,
  mapOmpSlashCommands,
} from "./commands.js";

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

  test("reports the folder of a skill so same-named skills can be told apart", () => {
    const commands = mapOmpRuntimeSlashCommands([
      {
        name: "skill:grill-with-docs",
        source: "skill",
        path: "/repo/.agents/skills/grill-with-docs/SKILL.md",
      },
      {
        name: "skill:agents/grill-with-docs",
        source: "skill",
        path: "/home/k/.agents/skills/grill-with-docs/SKILL.md",
      },
    ]);

    expect(commands.filter((command) => command.kind === "skill")).toEqual([
      {
        name: "skill:grill-with-docs",
        description: "skill",
        argumentHint: "",
        kind: "skill",
        sourcePath: "/repo/.agents/skills/grill-with-docs",
      },
      {
        name: "skill:agents/grill-with-docs",
        description: "skill",
        argumentHint: "",
        kind: "skill",
        sourcePath: "/home/k/.agents/skills/grill-with-docs",
      },
    ]);
  });

  test("leaves sourcePath unset for older OMP builds and for non-skill commands", () => {
    const commands = mapOmpSlashCommands([
      { name: "skill:legacy", source: "skill" },
      { name: "custom", source: "custom", path: "/repo/.omp/commands/custom.md" },
    ]);

    expect(commands.find((command) => command.name === "skill:legacy")).not.toHaveProperty(
      "sourcePath",
    );
    expect(commands.find((command) => command.name === "custom")).not.toHaveProperty("sourcePath");
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
