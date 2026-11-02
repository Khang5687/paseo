import { trimBlankLines, untaggedShellCommand } from "./detect";

/** Fence languages whose body is a command a reader would paste into a shell. */
const SHELL_FENCE_LANGUAGES: Record<string, true> = {
  bash: true,
  sh: true,
  shell: true,
  zsh: true,
  console: true,
};

const CONSOLE_PROMPT = /^\s*\$ ?(.*)$/;
const CONSOLE_CONTINUATION_PREFIX = /^\s*> ?/;
const COMMENT_LINE = /^\s*#/;
const PASSWORD_PROMPT = /\[sudo\] password for|password:|passphrase/i;

/**
 * The command a fence runs, or null when the fence is not a runnable shell block. Untagged
 * fences run only when they read as commands; other languages never run.
 */
export function shellFenceCommand(
  language: string | null | undefined,
  code: string,
): string | null {
  const fenceLanguage = language?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!fenceLanguage) return untaggedShellCommand(code);
  if (!Object.hasOwn(SHELL_FENCE_LANGUAGES, fenceLanguage)) return null;
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const commandLines = trimBlankLines(
    fenceLanguage === "console" ? consoleCommandLines(lines) : lines,
  );
  // A block of comments alone leaves the wrapping `{ }` group empty, which no shell accepts.
  const hasCommand = commandLines.some((line) => line.trim() !== "" && !COMMENT_LINE.test(line));
  return hasCommand ? commandLines.join("\n") : null;
}

/** `$ ` lines are commands; a trailing backslash carries the command onto the next line. */
function consoleCommandLines(lines: readonly string[]): string[] {
  const commands: string[] = [];
  let continuing = false;
  for (const line of lines) {
    if (continuing) {
      const continued = line.replace(CONSOLE_CONTINUATION_PREFIX, "");
      commands.push(continued);
      continuing = continued.endsWith("\\");
      continue;
    }
    const prompt = CONSOLE_PROMPT.exec(line);
    if (!prompt) continue;
    commands.push(prompt[1]);
    continuing = prompt[1].endsWith("\\");
  }
  return commands;
}

/**
 * The keystrokes that run a command in an interactive POSIX shell and leave its timing and
 * exit status in the terminal text.
 *
 * - The first line turns on comments for zsh, which ignores `#` at its prompt by default.
 *   Other shells reject `setopt` silently.
 * - The `{ }` group makes the shell read every line before running any, so a command that
 *   reads stdin (sudo, a confirmation) cannot swallow the lines after it, and one status
 *   covers the whole block.
 * - The start and status lines are plain text stamped with the host's clock, so a card that
 *   reattaches after the command ended reads both from the captured screen. Every wrapper
 *   line carries the nonce so the card can hide it.
 */
export function buildRunInput(command: string, nonce: string): string {
  const lines = [
    `: ${nonce}; setopt interactive_comments 2>/dev/null`,
    `{ printf '[start %s] %s\\n' "$(date +%s)" ${nonce}`,
    ...command.split("\n"),
    `}; printf '\\n[exit %s %s] %s\\n' "$?" "$(date +%s)" ${nonce}`,
  ];
  return `${lines.join("\r")}\r`;
}

export interface RunOutput {
  /** Lines the command printed, without the shell's echo of the wrapper. */
  lines: string[];
  exitCode: number | null;
  /** Whole seconds on the host's clock; null until the run ends. */
  durationSeconds: number | null;
}

/**
 * Reads a run's output from the terminal's captured text.
 *
 * `complete` says the capture starts at the top of the terminal. When it does not, and the
 * wrapper echo has scrolled out of the window, every captured line is output.
 */
export function readRunOutput(input: {
  lines: readonly string[];
  nonce: string;
  complete: boolean;
}): RunOutput {
  const { lines, nonce, complete } = input;
  const startLine = new RegExp(`^\\[start (\\d+)\\] ${nonce}$`);
  const statusLine = new RegExp(`^\\[exit (\\d+) (\\d+)\\] ${nonce}$`);
  let echoEnd = -1;
  let statusIndex = -1;
  let startedAt: number | null = null;
  let exitCode: number | null = null;
  let durationSeconds: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const status = statusLine.exec(line);
    if (status) {
      statusIndex = index;
      exitCode = Number(status[1]);
      if (startedAt !== null) durationSeconds = Math.max(0, Number(status[2]) - startedAt);
      break;
    }
    const start = startLine.exec(line);
    if (start) startedAt = Number(start[1]);
    if (line.includes(nonce)) echoEnd = index;
  }
  if (echoEnd === -1 && complete) return { lines: [], exitCode, durationSeconds };
  const end = statusIndex === -1 ? lines.length : statusIndex;
  const output = trimBlankLines(lines.slice(echoEnd + 1, end));
  return { lines: output, exitCode, durationSeconds };
}

/** What the command is waiting for, read from the line it last printed. */
export type RunPrompt = { kind: "password"; sudo: boolean } | { kind: "confirm" } | null;

const CONFIRM_PROMPT = /\[y\/n\]|\(y\/n\)|\[yes\/no\]|\(yes\/no\)|continue\?/i;

export function readRunPrompt(lines: readonly string[]): RunPrompt {
  const last = lines.at(-1);
  if (last === undefined) return null;
  if (PASSWORD_PROMPT.test(last)) return { kind: "password", sudo: /\[sudo\]/i.test(last) };
  if (CONFIRM_PROMPT.test(last)) return { kind: "confirm" };
  return null;
}

/** Commands worth a second look before the tap: elevated, or deleting recursively. */
export type CommandRisk = "admin" | "deletes" | null;

const COMMAND_SEPARATOR = /[\n;&|()]/;
const LEADING_ASSIGNMENTS = /^(?:[A-Za-z_]\w*=\S*\s+)+/;
const ELEVATED = /^(?:sudo|doas)(?:\s|$)/;
const RECURSIVE_DELETE = /\brm\s+(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r|-r\s+-f|-f\s+-r)\b/;

export function commandRisk(command: string): CommandRisk {
  const segments = command.split(COMMAND_SEPARATOR);
  if (segments.some((segment) => ELEVATED.test(segment.trim().replace(LEADING_ASSIGNMENTS, ""))))
    return "admin";
  if (RECURSIVE_DELETE.test(command)) return "deletes";
  return null;
}

/** `3s`, `2m 05s`, `1h 02m`: compact enough for a status line on a phone. */
export function formatRunDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const AGENT_OUTPUT_LIMIT = 8000;

export interface RunReport {
  command: string;
  output: readonly string[];
  /** Null when the run was stopped before it reported a status. */
  exitCode: number | null;
  labels: { exitStatus: string; stopped: string; truncated: string };
}

/** Markdown for the composer: the command, the tail of its output and how it ended. */
export function formatRunReport(report: RunReport): string {
  let output = report.output.join("\n");
  let truncated = false;
  if (output.length > AGENT_OUTPUT_LIMIT) {
    output = output.slice(output.length - AGENT_OUTPUT_LIMIT);
    output = output.slice(output.indexOf("\n") + 1);
    truncated = true;
  }
  const body = [`$ ${report.command}`, ...(truncated ? [report.labels.truncated] : []), output]
    .filter((part) => part !== "")
    .join("\n");
  const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
  const ending =
    report.exitCode === null
      ? report.labels.stopped
      : `${report.labels.exitStatus} ${report.exitCode}`;
  return `${fence}console\n${body}\n${fence}\n${ending}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/** Short random token that marks one run's wrapper lines in the terminal. */
export function createRunNonce(): string {
  return `paseo-run-${Math.random().toString(36).slice(2, 10)}`;
}

/** Stable identity of a fence's text inside one message. */
export function hashCode(code: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
