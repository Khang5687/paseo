import { describe, expect, it } from "vitest";
import { untaggedShellCommand } from "./detect";
import { shellFenceCommand } from "./command";

describe("untaggedShellCommand", () => {
  it("runs the one-liner agents write without a language tag", () => {
    expect(untaggedShellCommand("sudo bash /tmp/control-room-buttons-tab-apply.sh\n")).toBe(
      "sudo bash /tmp/control-room-buttons-tab-apply.sh",
    );
  });

  it("accepts env prefixes, sudo options and path executables", () => {
    expect(untaggedShellCommand("NODE_ENV=production PORT=3000 node server.js")).not.toBeNull();
    expect(untaggedShellCommand("sudo -u www -E ./deploy.sh --force")).not.toBeNull();
    expect(untaggedShellCommand("~/bin/sync-notes")).toBeNull();
    expect(untaggedShellCommand("~/bin/sync-notes --all")).not.toBeNull();
  });

  it("treats chained and continued lines as one command", () => {
    const chain = [
      "cd packages/app &&",
      "  npm ci \\",
      "    --prefer-offline",
      "npm run build | tee build.log",
    ].join("\n");
    expect(untaggedShellCommand(chain)).toBe(chain);
  });

  it("strips `$ ` prompts and keeps comments", () => {
    expect(untaggedShellCommand("# update\n$ git pull\n$ npm install")).toBe(
      "# update\ngit pull\nnpm install",
    );
  });

  it("rejects blocks that are not commands", () => {
    const json = '{\n  "name": "paseo",\n  "private": true\n}';
    const typescript = "const response = await fetch(url);\nreturn response.json();";
    const log = [
      "2026-10-31T12:00:01Z ERROR request failed",
      "    at handle (server.ts:41:9)",
    ].join("\n");
    const mixedOutput = "ls\nREADME.md  package.json  src";
    const mermaid = "graph TD\nA-->B";
    for (const block of [json, typescript, log, mixedOutput, mermaid]) {
      expect(untaggedShellCommand(block)).toBeNull();
    }
  });

  it("rejects a lone file path and prose", () => {
    expect(untaggedShellCommand("/Users/me/git/paseo/src/app.ts")).toBeNull();
    expect(untaggedShellCommand("./README.md")).toBeNull();
    expect(untaggedShellCommand("Run the tests before you push.")).toBeNull();
    expect(untaggedShellCommand("cd into the folder and run make.")).toBeNull();
  });

  it("rejects brace-heavy code that starts like a command", () => {
    expect(untaggedShellCommand('echo \'{"a": {"b": {"c": 1}}}\'')).toBeNull();
    expect(untaggedShellCommand("find . -name '*.log' -exec rm {} \\;")).not.toBeNull();
  });

  it("rejects long scripts and comment-only blocks", () => {
    const script = Array.from({ length: 30 }, (_, index) => `echo step ${index}`).join("\n");
    expect(untaggedShellCommand(script)).toBeNull();
    expect(untaggedShellCommand("# nothing to run")).toBeNull();
    expect(untaggedShellCommand("   \n")).toBeNull();
  });
});

describe("shellFenceCommand language routing", () => {
  it("detects untagged fences and never runs other languages", () => {
    expect(shellFenceCommand(null, "git status")).toBe("git status");
    expect(shellFenceCommand("", "git status")).toBe("git status");
    expect(shellFenceCommand("text", "git status")).toBeNull();
    expect(shellFenceCommand("bash", "my-custom-tool --flag")).toBe("my-custom-tool --flag");
    expect(shellFenceCommand(null, "my-custom-tool --flag")).toBeNull();
  });
});
