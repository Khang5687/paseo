import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentSlashCommand } from "../../agent-sdk-types.js";
import { attachOmpSkillSourcePaths } from "./skill-source-path.js";

let tmp: string;
let home: string;
let repo: string;

function writeSkill(root: string, name: string, description: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
  );
  return dir;
}

function skillCommand(name: string, description: string): AgentSlashCommand {
  return { name, description, argumentHint: "", kind: "skill" };
}

async function resolve(commands: AgentSlashCommand[], cwd = repo) {
  return await attachOmpSkillSourcePaths(commands, { cwd, home });
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "omp-skill-path-"));
  home = path.join(tmp, "home");
  repo = path.join(home, "work", "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("attachOmpSkillSourcePaths", () => {
  test("tells a project skill from a same-named home skill by description", async () => {
    const projectDir = writeSkill(path.join(repo, ".agents", "skills"), "grill", "Project grill");
    const homeDir = writeSkill(path.join(home, ".agents", "skills"), "grill", "Home grill");

    const [project, user] = await resolve([
      skillCommand("skill:grill", "Project grill"),
      skillCommand("skill:agents/grill", "Home grill"),
    ]);

    expect(project?.sourcePath).toBe(projectDir);
    expect(user?.sourcePath).toBe(homeDir);
  });

  test("keeps the namespace prefix: agents/ never resolves to a claude skill", async () => {
    writeSkill(path.join(home, ".claude", "skills"), "tool", "Same words");
    const agentsDir = writeSkill(path.join(home, ".agents", "skills"), "tool", "Same words");

    const [namespaced] = await resolve([skillCommand("skill:agents/tool", "Same words")]);

    expect(namespaced?.sourcePath).toBe(agentsDir);
  });

  test("walks up from a subfolder to the repo root", async () => {
    const skillDir = writeSkill(path.join(repo, ".claude", "skills"), "deep", "Found from below");
    const sub = path.join(repo, "packages", "a");
    mkdirSync(sub, { recursive: true });

    const [command] = await resolve([skillCommand("skill:deep", "Found from below")], sub);

    expect(command?.sourcePath).toBe(skillDir);
  });

  test("leaves the path unset when no SKILL.md matches", async () => {
    writeSkill(path.join(home, ".agents", "skills"), "other", "Something else");
    writeSkill(path.join(home, ".agents", "skills"), "lonely", "Different description");

    const [none, mismatch] = await resolve([
      skillCommand("skill:missing", "Nobody has this"),
      skillCommand("skill:lonely", "Plugin skill with the same name"),
    ]);

    expect(none?.sourcePath).toBeUndefined();
    expect(mismatch?.sourcePath).toBeUndefined();
  });

  test("leaves the path unset when two candidates match equally", async () => {
    writeSkill(path.join(repo, ".agents", "skills"), "twin", "Identical");
    writeSkill(path.join(home, ".agents", "skills"), "twin", "Identical");

    const [command] = await resolve([skillCommand("skill:twin", "Identical")]);

    expect(command?.sourcePath).toBeUndefined();
  });

  test("ignores non-skill commands and skills whose name escapes the root", async () => {
    const commands: AgentSlashCommand[] = [
      { name: "compact", description: "Compact", argumentHint: "", kind: "command" },
      skillCommand("skill:../escape", "x"),
    ];

    const result = await resolve(commands);

    expect(result).toEqual(commands);
  });
});
