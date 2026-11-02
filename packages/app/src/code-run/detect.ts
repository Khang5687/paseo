/**
 * Recognizes an untagged fence that is a shell command. Agents often leave the language off
 * one-liners; a false Run on prose or code costs more than a missing one, so every line must
 * start like a command and anything that reads as output, code or prose rejects the block.
 */

const MAX_LINES = 20;
/** Shell lines rarely carry more braces than `find -exec {} \;`; code and JSON do. */
const MAX_BRACES = 4;

const KNOWN_COMMANDS: Record<string, true> = {
  bash: true,
  sh: true,
  zsh: true,
  npm: true,
  npx: true,
  pnpm: true,
  yarn: true,
  bun: true,
  node: true,
  python: true,
  python3: true,
  pip: true,
  pip3: true,
  uv: true,
  git: true,
  gh: true,
  brew: true,
  apt: true,
  "apt-get": true,
  dnf: true,
  pacman: true,
  systemctl: true,
  journalctl: true,
  launchctl: true,
  docker: true,
  "docker-compose": true,
  kubectl: true,
  make: true,
  cargo: true,
  go: true,
  cd: true,
  ls: true,
  cat: true,
  cp: true,
  mv: true,
  rm: true,
  mkdir: true,
  chmod: true,
  chown: true,
  ln: true,
  curl: true,
  wget: true,
  ssh: true,
  scp: true,
  rsync: true,
  tar: true,
  unzip: true,
  open: true,
  code: true,
  paseo: true,
  omp: true,
  claude: true,
  codex: true,
  export: true,
  source: true,
  echo: true,
  kill: true,
  pkill: true,
  lsof: true,
  ps: true,
  df: true,
  du: true,
  tail: true,
  head: true,
  grep: true,
  rg: true,
  find: true,
  sed: true,
  awk: true,
  xargs: true,
  tee: true,
  env: true,
  which: true,
  adb: true,
  xcrun: true,
  expo: true,
  eas: true,
};

const ELEVATORS: Record<string, true> = { sudo: true, doas: true };
/** sudo options that take a value, so the value is not mistaken for the command. */
const SUDO_VALUE_OPTIONS: Record<string, true> = { "-u": true, "-g": true, "-C": true, "-D": true };

const PROMPT = /^\s*\$\s+/;
const COMMENT = /^\s*#/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PATH_EXECUTABLE = /^(?:\.{1,2}\/|\/|~\/)\S/;
/** A trailing operator or backslash carries the command onto the next line. */
const CONTINUES = /(?:\\|&&|\|\||\||;)\s*$/;
/** A sentence: four or more words ending in a letter followed by `.`, `!` or `?`. */
const SENTENCE_END = /[A-Za-z]{2,}[.!?]$/;

/** The command an untagged fence runs, or null when the block does not read as one. */
export function untaggedShellCommand(code: string): string | null {
  const lines = trimBlankLines(code.replace(/\r\n?/g, "\n").split("\n"));
  if (lines.length === 0 || lines.length > MAX_LINES) return null;
  if (countBraces(code) > MAX_BRACES) return null;
  const commandLines: string[] = [];
  let continuing = false;
  let commands = 0;
  for (const raw of lines) {
    const line = raw.replace(PROMPT, "");
    commandLines.push(line);
    if (continuing) {
      continuing = CONTINUES.test(line);
      continue;
    }
    if (line.trim() === "" || COMMENT.test(line)) continue;
    if (!startsLikeCommand(line) || readsAsSentence(line)) return null;
    commands += 1;
    continuing = CONTINUES.test(line);
  }
  if (commands === 0) return null;
  // A single path on its own is a file reference, not something to execute.
  if (commandLines.length === 1 && isLonePath(commandLines[0])) return null;
  return commandLines.join("\n");
}

function startsLikeCommand(line: string): boolean {
  const tokens = line.trim().split(/\s+/);
  let index = 0;
  while (index < tokens.length && ASSIGNMENT.test(tokens[index])) index += 1;
  if (index < tokens.length && Object.hasOwn(ELEVATORS, tokens[index])) {
    index += 1;
    while (index < tokens.length && tokens[index].startsWith("-")) {
      index += Object.hasOwn(SUDO_VALUE_OPTIONS, tokens[index]) ? 2 : 1;
    }
  }
  const command = tokens[index];
  if (command === undefined) return false;
  return Object.hasOwn(KNOWN_COMMANDS, command) || PATH_EXECUTABLE.test(command);
}

function readsAsSentence(line: string): boolean {
  const trimmed = line.trim();
  return SENTENCE_END.test(trimmed) && trimmed.split(/\s+/).length >= 4;
}

function isLonePath(line: string): boolean {
  const trimmed = line.trim();
  return !/\s/.test(trimmed) && PATH_EXECUTABLE.test(trimmed);
}

function countBraces(code: string): number {
  let braces = 0;
  for (const character of code) if (character === "{" || character === "}") braces += 1;
  return braces;
}

export function trimBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}
