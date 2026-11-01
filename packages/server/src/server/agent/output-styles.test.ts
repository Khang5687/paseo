import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { discoverOutputStyleFiles } from "./output-styles.js";

function writeStyle(dir: string, fileName: string, source: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), source);
}

describe("discoverOutputStyleFiles", () => {
  test("reads user and project styles; the closest project dir wins a name clash", async () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-output-styles-"));
    const claudeDir = join(root, "claude-config");
    const repo = join(root, "repo");
    const cwd = join(repo, "packages", "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    writeStyle(
      join(claudeDir, "output-styles"),
      "eli5.md",
      "---\nname: ELI5\ndescription: keep it simple pls\nkeep-coding-instructions: true\n---\n\nTalk to me like I'm 5.\n",
    );
    writeStyle(join(claudeDir, "output-styles"), "terse.md", "User terse.");
    writeStyle(join(repo, ".claude", "output-styles"), "terse.md", "Repo terse.");
    writeStyle(join(cwd, ".claude", "output-styles"), "terse.md", "Package terse.");
    writeStyle(join(cwd, ".claude", "output-styles"), "blank.md", "---\nname: Blank\n---\n\n");
    // Above the git root, so not part of this project.
    writeStyle(join(root, ".claude", "output-styles"), "outside.md", "Outside.");

    const styles = await discoverOutputStyleFiles({
      cwd,
      env: { CLAUDE_CONFIG_DIR: claudeDir },
    });

    expect(styles).toEqual([
      { name: "ELI5", description: "keep it simple pls", body: "Talk to me like I'm 5." },
      { name: "terse", body: "Package terse." },
    ]);
  });

  test("returns nothing when no style dirs exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-output-styles-empty-"));
    mkdirSync(join(root, ".git"));
    await expect(
      discoverOutputStyleFiles({ cwd: root, env: { CLAUDE_CONFIG_DIR: join(root, "none") } }),
    ).resolves.toEqual([]);
  });
});
