import { describe, expect, it } from "vitest";
import {
  buildRunInput,
  commandRisk,
  formatRunDuration,
  formatRunReport,
  readRunOutput,
  readRunPrompt,
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
        `{ printf '[start %s] %s\\n' "$(date +%s)" ${NONCE}`,
        "sudo true",
        "echo ok",
        `}; printf '\\n[exit %s %s] %s\\n' "$?" "$(date +%s)" ${NONCE}`,
        "",
      ].join("\r"),
    );
  });
});

describe("readRunOutput", () => {
  const screen = [
    `me@host app % : ${NONCE}; setopt interactive_comments 2>/dev/null`,
    `me@host app % { printf '[start %s] %s\\n' "$(date +%s)" ${NONCE}`,
    "cursh> npm test",
    `cursh> }; printf '\\n[exit %s %s] %s\\n' "$?" "$(date +%s)" ${NONCE}`,
    `[start 1730000000] ${NONCE}`,
    "PASS src/a.test.ts",
    "",
    `[exit 1 1730000003] ${NONCE}`,
    "me@host app %",
    "",
  ];

  it("returns the output between the start and status lines with the host duration", () => {
    expect(readRunOutput({ lines: screen, nonce: NONCE, complete: true })).toEqual({
      lines: ["PASS src/a.test.ts"],
      exitCode: 1,
      durationSeconds: 3,
    });
  });

  it("reports a running command without a status", () => {
    expect(readRunOutput({ lines: screen.slice(0, 6), nonce: NONCE, complete: true })).toEqual({
      lines: ["PASS src/a.test.ts"],
      exitCode: null,
      durationSeconds: null,
    });
  });

  it("shows nothing before the shell has read the command", () => {
    expect(readRunOutput({ lines: ["me@host app %", ""], nonce: NONCE, complete: true })).toEqual({
      lines: [],
      exitCode: null,
      durationSeconds: null,
    });
  });

  it("treats a window whose echo scrolled away as all output", () => {
    expect(
      readRunOutput({
        lines: ["line 900", "line 901", `[exit 0 1730000009] ${NONCE}`],
        nonce: NONCE,
        complete: false,
      }),
    ).toEqual({ lines: ["line 900", "line 901"], exitCode: 0, durationSeconds: null });
  });

  it("ignores another run's status line", () => {
    const other = [...screen.slice(0, 6), "[exit 0 1730000003] paseo-run-other"];
    expect(readRunOutput({ lines: other, nonce: NONCE, complete: true }).exitCode).toBeNull();
  });
});

describe("readRunPrompt", () => {
  it("recognizes the password prompts sudo, ssh and login tools print", () => {
    expect(readRunPrompt(["Building", "[sudo] password for khang:"])).toEqual({
      kind: "password",
      sudo: true,
    });
    expect(readRunPrompt(["Password:"])).toEqual({ kind: "password", sudo: false });
    expect(readRunPrompt(["Enter passphrase for key '/Users/me/.ssh/id_ed25519':"])).toEqual({
      kind: "password",
      sudo: false,
    });
  });

  it("recognizes yes/no confirmations", () => {
    for (const line of ["Proceed? [y/N]", "Overwrite (y/n)", "Are you sure (yes/no)?", "Continue?"])
      expect(readRunPrompt([line])).toEqual({ kind: "confirm" });
  });

  it("only looks at the line being waited on", () => {
    expect(readRunPrompt(["Password:", "Done"])).toBeNull();
    expect(readRunPrompt([])).toBeNull();
  });
});

describe("commandRisk", () => {
  it("flags elevation anywhere a command starts", () => {
    expect(commandRisk("sudo bash /tmp/apply.sh")).toBe("admin");
    expect(commandRisk("cd /etc && sudo vim hosts")).toBe("admin");
    expect(commandRisk("FOO=1 doas reboot")).toBe("admin");
    expect(commandRisk("echo pseudo sudoers")).toBeNull();
  });

  it("flags recursive deletes", () => {
    expect(commandRisk("rm -rf node_modules")).toBe("deletes");
    expect(commandRisk("rm -fr build")).toBe("deletes");
    expect(commandRisk("rm -r -f dist")).toBe("deletes");
    expect(commandRisk("rm file.txt")).toBeNull();
  });
});

describe("formatRunDuration", () => {
  it("stays short at every scale", () => {
    expect(formatRunDuration(3)).toBe("3s");
    expect(formatRunDuration(125)).toBe("2m 05s");
    expect(formatRunDuration(3720)).toBe("1h 02m");
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
