import { describe, expect, it } from "vitest";
import {
  buildRunInput,
  formatRunReport,
  isPasswordPrompt,
  readRunOutput,
  shellFenceCommand,
} from "./command";

const NONCE = "paseo-run-abc123";

describe("shellFenceCommand", () => {
  it("runs only shell fence languages", () => {
    expect(shellFenceCommand("bash", "npm test\n")).toBe("npm test");
    expect(shellFenceCommand("SH", "ls")).toBe("ls");
    expect(shellFenceCommand("zsh title=x", "ls")).toBe("ls");
    expect(shellFenceCommand("ts", "ls")).toBeNull();
    expect(shellFenceCommand("powershell", "ls")).toBeNull();
    expect(shellFenceCommand("constructor", "ls")).toBeNull();
    expect(shellFenceCommand(null, "ls")).toBeNull();
  });

  it("keeps a multi-line script intact apart from surrounding blank lines", () => {
    expect(shellFenceCommand("bash", "\n# install\nnpm ci\n\nnpm test\n\n")).toBe(
      "# install\nnpm ci\n\nnpm test",
    );
  });

  it("does not offer a block with no command", () => {
    expect(shellFenceCommand("bash", "# just a note\n\n")).toBeNull();
    expect(shellFenceCommand("sh", "   \n")).toBeNull();
  });

  it("takes console prompts and drops their output", () => {
    const transcript = "$ git status\nOn branch main\n$ npm run build \\\n> --watch\nwatching...\n";
    expect(shellFenceCommand("console", transcript)).toBe("git status\nnpm run build \\\n--watch");
    expect(shellFenceCommand("console", "On branch main\nnothing to commit")).toBeNull();
  });
});

describe("buildRunInput", () => {
  it("groups the block so stdin readers cannot consume the status line", () => {
    expect(buildRunInput("sudo true\necho ok", NONCE)).toBe(
      [
        `: ${NONCE}; setopt interactive_comments 2>/dev/null`,
        "{ sudo true",
        "echo ok",
        `}; printf '\\n[exit %s] %s\\n' "$?" ${NONCE}`,
        "",
      ].join("\r"),
    );
  });
});

describe("readRunOutput", () => {
  const screen = [
    `me@host app % : ${NONCE}; setopt interactive_comments 2>/dev/null`,
    "me@host app % { npm test",
    `cursh> }; printf '\\n[exit %s] %s\\n' "$?" ${NONCE}`,
    "PASS src/a.test.ts",
    "",
    `[exit 1] ${NONCE}`,
    "me@host app %",
    "",
  ];

  it("returns the output between the wrapper echo and the status line", () => {
    expect(readRunOutput({ lines: screen, nonce: NONCE, complete: true })).toEqual({
      lines: ["PASS src/a.test.ts"],
      exitCode: 1,
    });
  });

  it("reports a running command without a status", () => {
    expect(readRunOutput({ lines: screen.slice(0, 4), nonce: NONCE, complete: true })).toEqual({
      lines: ["PASS src/a.test.ts"],
      exitCode: null,
    });
  });

  it("shows nothing before the shell has read the command", () => {
    expect(readRunOutput({ lines: ["me@host app %", ""], nonce: NONCE, complete: true })).toEqual({
      lines: [],
      exitCode: null,
    });
  });

  it("treats a window whose echo scrolled away as all output", () => {
    expect(
      readRunOutput({
        lines: ["line 900", "line 901", `[exit 0] ${NONCE}`],
        nonce: NONCE,
        complete: false,
      }),
    ).toEqual({ lines: ["line 900", "line 901"], exitCode: 0 });
  });

  it("ignores another run's status line", () => {
    const other = [...screen.slice(0, 4), "[exit 0] paseo-run-other"];
    expect(readRunOutput({ lines: other, nonce: NONCE, complete: true }).exitCode).toBeNull();
  });
});

describe("isPasswordPrompt", () => {
  it("matches the prompts sudo, ssh and login tools print", () => {
    expect(isPasswordPrompt(["Building", "[sudo] password for khang:"])).toBe(true);
    expect(isPasswordPrompt(["Password:"])).toBe(true);
    expect(isPasswordPrompt(["Enter passphrase for key '/Users/me/.ssh/id_ed25519':"])).toBe(true);
  });

  it("only looks at the line being waited on", () => {
    expect(isPasswordPrompt(["Password:", "Done"])).toBe(false);
    expect(isPasswordPrompt([])).toBe(false);
  });
});

describe("formatRunReport", () => {
  const labels = {
    exitStatus: "Exit status",
    stopped: "Stopped",
    truncated: "[earlier output cut]",
  };

  it("fences the command with its output and ending", () => {
    expect(formatRunReport({ command: "ls", output: ["a", "b"], exitCode: 0, labels })).toBe(
      "```console\n$ ls\na\nb\n```\nExit status 0",
    );
    expect(formatRunReport({ command: "sleep 9", output: [], exitCode: null, labels })).toBe(
      "```console\n$ sleep 9\n```\nStopped",
    );
  });

  it("keeps the tail of long output on whole lines", () => {
    const output = Array.from({ length: 2000 }, (_, index) => `line ${index}`);
    const report = formatRunReport({ command: "seq", output, exitCode: 0, labels });
    expect(report).toContain("[earlier output cut]\n");
    expect(report).toContain("line 1999\n```");
    expect(report).not.toContain("line 0\n");
    expect(report.length).toBeLessThan(8200);
    const firstKept = report.split("\n")[3];
    expect(firstKept).toMatch(/^line \d+$/);
  });

  it("uses a longer fence when the output contains one", () => {
    const report = formatRunReport({
      command: "cat x.md",
      output: ["```js", "```"],
      exitCode: 0,
      labels,
    });
    expect(report.startsWith("````console\n")).toBe(true);
  });
});
