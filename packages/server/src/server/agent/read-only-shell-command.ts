/**
 * Decides whether a shell command line only reads. Used to auto-approve shell commands for agents
 * in a read-only mode, so the answer must never be "yes" for a command that can change something:
 * anything this module does not understand is not read-only.
 *
 * The check parses one line of POSIX shell: words, quotes, `|`, `||`, `&&` and `;`. It refuses
 * any `$` outside single quotes (the shell is persistent, so a variable can hold anything),
 * command substitution, subshells, background jobs, comments, environment assignments, and
 * redirects other than to `/dev/null`, to another descriptor, or from a file. A command with an
 * argument check refuses unquoted globs, which can expand to a file named like a flag.
 * Every command in the line must be on the allowlist below and pass its argument check, and no
 * word or redirect target may name a secret path (see `SECRET_PATHS`): those still ask.
 */

type ArgumentCheck = (args: readonly string[]) => boolean;

const ANY_ARGUMENTS: ArgumentCheck = () => true;

const READ_ONLY_COMMANDS: ReadonlyMap<string, ArgumentCheck> = new Map<string, ArgumentCheck>([
  ...[
    "basename",
    "cat",
    "cd",
    "cksum",
    "cmp",
    "column",
    "comm",
    "cut",
    "df",
    "diff",
    "dirname",
    "du",
    "echo",
    "egrep",
    "false",
    "fgrep",
    "fold",
    "free",
    "grep",
    "head",
    "hexdump",
    "id",
    "join",
    "ls",
    "md5sum",
    "nl",
    "nproc",
    "od",
    "paste",
    "pwd",
    "readlink",
    "realpath",
    "rev",
    "seq",
    "sha1sum",
    "sha256sum",
    "sha512sum",
    "stat",
    "strings",
    "tac",
    "tail",
    "test",
    "tr",
    "true",
    "type",
    "uname",
    "uptime",
    "wc",
    "which",
    "whoami",
  ].map((name): [string, ArgumentCheck] => [name, ANY_ARGUMENTS]),
  // `e` (BSD style, no dash) prints each process's environment.
  ["ps", (args) => !args.some((arg) => !arg.startsWith("-") && arg.includes("e"))],
  // `env` and `$ENV` print the environment.
  ["jq", (args) => !args.some((arg) => /env/i.test(arg))],
  // -v assigns a shell variable, which outlives the command in a persistent shell.
  ["printf", (args) => !hasFlag(args, "v", [])],
  // -C compiles a magic file next to the input.
  ["file", (args) => !hasFlag(args, "C", ["--compile"])],
  // -s sets the clock.
  ["date", (args) => !hasFlag(args, "s", ["--set"])],
  // -o writes the output to a file; --compress-program runs a program.
  ["sort", (args) => !hasFlag(args, "o", ["--output", "--compress-program"])],
  // A second operand is an output file.
  ["uniq", (args) => args.filter((arg) => !arg.startsWith("-")).length <= 1],
  // -o writes the listing to a file; -R writes an HTML index into every directory.
  ["tree", (args) => !hasFlag(args, "oR", [])],
  ["find", (args) => !args.some((arg) => FIND_ACTIONS.some((action) => arg.startsWith(action)))],
  // --pre runs a program on every file.
  ["rg", (args) => !hasFlag(args, "", ["--pre"])],
  ["fd", (args) => !hasFlag(args, "xX", ["--exec", "--exec-batch"])],
  ["git", isReadOnlyGitCommand],
]);

const FIND_ACTIONS = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fls"];

/**
 * True when `args` holds one of the short flags (as its own argument or inside a cluster like
 * `-bo`) or a long flag, with or without `=value`. Over-matches a short flag's value on purpose.
 */
function hasFlag(
  args: readonly string[],
  shortFlags: string,
  longFlags: readonly string[],
): boolean {
  return args.some((arg) => {
    if (arg.startsWith("--")) {
      return longFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
    }
    if (arg.startsWith("-") && arg.length > 1) {
      return arg
        .slice(1)
        .split("")
        .some((letter) => shortFlags.includes(letter));
    }
    return false;
  });
}

// --output writes a file; --ext-diff runs an external diff program; -O opens a pager program.
const GIT_HISTORY_CHECK: ArgumentCheck = (args) =>
  !hasFlag(args, "O", ["--output", "--ext-diff", "--open-files-in-pager"]);

const GIT_SUBCOMMANDS: ReadonlyMap<string, ArgumentCheck> = new Map<string, ArgumentCheck>([
  ...[
    "blame",
    "cat-file",
    "check-attr",
    "check-ignore",
    "count-objects",
    "describe",
    "diff",
    "diff-files",
    "diff-index",
    "diff-tree",
    "grep",
    "log",
    "ls-files",
    "ls-remote",
    "ls-tree",
    "merge-base",
    "name-rev",
    "rev-list",
    "rev-parse",
    "shortlog",
    "show",
    "show-ref",
    "status",
    "version",
    "whatchanged",
  ].map((name): [string, ArgumentCheck] => [name, GIT_HISTORY_CHECK]),
  ["for-each-ref", ANY_ARGUMENTS],
  // Listing only: any argument that is not a flag names a branch to create.
  [
    "branch",
    (args) =>
      args.every((arg) => arg.startsWith("-")) &&
      !hasFlag(args, "dDmMcCfu", [
        "--delete",
        "--move",
        "--copy",
        "--force",
        "--set-upstream-to",
        "--unset-upstream",
        "--edit-description",
        "--track",
        "--no-track",
      ]),
  ],
  [
    "tag",
    (args) =>
      args.length === 0 ||
      ((args[0] === "-l" || args[0] === "--list") &&
        args.slice(1).every((arg) => !arg.startsWith("-"))),
  ],
  [
    "remote",
    (args) =>
      args.length === 0 ||
      (args.length === 1 && (args[0] === "-v" || args[0] === "--verbose")) ||
      args[0] === "get-url" ||
      args[0] === "show",
  ],
  [
    "config",
    (args) =>
      args[0] === "get" ||
      args[0] === "list" ||
      (args.some((arg) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(arg)) &&
        !hasFlag(args, "e", [
          "--add",
          "--edit",
          "--replace-all",
          "--unset",
          "--unset-all",
          "--rename-section",
          "--remove-section",
        ])),
  ],
  [
    "reflog",
    (args) => args.length === 0 || args[0] === "show" || args[0]?.startsWith("-") === true,
  ],
  ["stash", (args) => args[0] === "list" || args[0] === "show"],
  ["worktree", (args) => args[0] === "list"],
]);

function isReadOnlyGitCommand(args: readonly string[]): boolean {
  let index = 0;
  // Global options that only pick the repository or turn the pager off. `-c` is refused: it can
  // set an alias, pager or hook command.
  while (index < args.length) {
    const arg = args[index];
    if (arg === "-C") {
      index += 2;
    } else if (
      arg === "--no-pager" ||
      arg === "-P" ||
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=")
    ) {
      index += 1;
    } else {
      break;
    }
  }
  const subcommand = args[index];
  if (subcommand === undefined) return false;
  const check = GIT_SUBCOMMANDS.get(subcommand);
  return check !== undefined && check(args.slice(index + 1));
}

/**
 * Paths whose contents are credentials. A word or redirect target matching one of these makes the
 * command ask, even when it only reads. Relative paths are matched as written, so a `cd` into a
 * secret directory matches through the `cd` word.
 */
const SECRET_PATHS: readonly RegExp[] = [
  // Paseo daemon home, SSH keys, GitHub CLI auth.
  /(?:^|[/=])\.paseo(?:\/|$)/,
  /(?:^|[/=])\.ssh(?:\/|$)/,
  /(?:^|[/=])\.config\/gh(?:\/|$)/,
  // OMP's credential vault, legacy auth file and broker tokens, or a glob that could reach them.
  /(?:^|[/=])\.omp\/agent(?:\/?$|\/[^/]*[*?[])/,
  /(?:^|[/=])(?:agent\.db|auth\.json)/,
  /(?:^|[/=])\.env(?:\.[^/]*)?$/,
  /(?:^|[/=])id_(?:rsa|ecdsa|ed25519|dsa)/,
  /\.(?:pem|key|token)$/,
  // A glob in a hidden path segment can expand to any of the above.
  /(?:^|\/)\.[^/]*[*?[]/,
];

function namesSecretPath(word: string): boolean {
  return SECRET_PATHS.some((pattern) => pattern.test(word));
}

export function isReadOnlyShellCommand(command: string): boolean {
  const parser = new ShellLineParser(command);
  const segments = parser.parse();
  if (!segments || segments.length === 0) return false;
  if (parser.redirectTargets.some(namesSecretPath)) return false;
  return segments.every((words) => {
    if (words.some((word) => namesSecretPath(word.text))) return false;
    const [name, ...args] = words;
    if (name === undefined || name.globbed || name.text.includes("=")) return false;
    const check = READ_ONLY_COMMANDS.get(name.text);
    if (check === undefined) return false;
    if (check !== ANY_ARGUMENTS && args.some((arg) => arg.globbed)) return false;
    return check(args.map((arg) => arg.text));
  });
}

interface ShellWord {
  text: string;
  /** Holds an unquoted `*`, `?` or `[`, so the shell may replace it with file names. */
  globbed: boolean;
}

// `{` starts brace expansion (`{-delete,}` becomes a flag) or a command group.
const UNSUPPORTED_CHARS = "\n\r`(){$";
const GLOB_CHARS = "*?[";

const PLAIN_TARGET = /^[\w./+-]+$/;
const TARGET_END = /[\s|&;<>()'"`$\\]/;

/**
 * Splits one command line into the words of each command. `parse` returns null for anything
 * outside the supported subset. Quote removal is applied; globs stay as written.
 */
class ShellLineParser {
  readonly redirectTargets: string[] = [];
  private readonly segments: ShellWord[][] = [];
  private words: ShellWord[] = [];
  private word = "";
  private inWord = false;
  private quoted = false;
  private globbed = false;
  private index = 0;

  constructor(private readonly line: string) {}

  parse(): ShellWord[][] | null {
    while (this.index < this.line.length) {
      if (!this.step()) return null;
    }
    return this.endSegment() ? this.segments : null;
  }

  private step(): boolean {
    const char = this.line[this.index];
    if (UNSUPPORTED_CHARS.includes(char)) return false;
    if (char === " " || char === "\t") {
      this.endWord();
      this.index += 1;
      return true;
    }
    if (char === "#" && !this.inWord) return false;
    if (char === "'") return this.readSingleQuoted();
    if (char === '"') return this.readDoubleQuoted();
    if (char === "\\") return this.readEscape();
    if (char === ">" || char === "<" || (char === "&" && this.line[this.index + 1] === ">")) {
      return this.readRedirect();
    }
    if (char === "|" || char === ";" || char === "&") return this.readOperator();
    if (GLOB_CHARS.includes(char)) this.globbed = true;
    this.append(char, 1, false);
    return true;
  }

  private append(text: string, length: number, quoted: boolean): void {
    this.word += text;
    this.inWord = true;
    this.quoted ||= quoted;
    this.index += length;
  }

  private readSingleQuoted(): boolean {
    const close = this.line.indexOf("'", this.index + 1);
    if (close < 0) return false;
    this.append(this.line.slice(this.index + 1, close), close + 1 - this.index, true);
    return true;
  }

  private readDoubleQuoted(): boolean {
    let text = "";
    let at = this.index + 1;
    while (at < this.line.length) {
      const char = this.line[at];
      const next = this.line[at + 1];
      if (char === '"') {
        this.append(text, at + 1 - this.index, true);
        return true;
      }
      if (char === "`" || char === "$") return false;
      // Inside double quotes a backslash only escapes these; elsewhere it stays in the word.
      if (char === "\\" && next !== undefined && '$`"\\'.includes(next)) {
        text += next;
        at += 2;
      } else {
        text += char;
        at += 1;
      }
    }
    return false;
  }

  private readEscape(): boolean {
    const next = this.line[this.index + 1];
    if (next === undefined || next === "\n" || next === "\r") return false;
    this.append(next, 2, true);
    return true;
  }

  private readOperator(): boolean {
    const char = this.line[this.index];
    const next = this.line[this.index + 1];
    // A lone `&` runs a background job and `|&` pipes stderr; neither is supported.
    if ((char === "&" && next !== "&") || (char === "|" && next === "&")) return false;
    if (!this.endSegment()) return false;
    this.index += char !== ";" && next === char ? 2 : 1;
    return true;
  }

  private readRedirect(): boolean {
    // A bare number right before the operator is the descriptor it applies to.
    if (this.inWord && !this.quoted && /^\d+$/.test(this.word)) {
      this.word = "";
      this.inWord = false;
    } else {
      this.endWord();
    }
    if (this.line[this.index] === "<") {
      const next = this.line[this.index + 1];
      if (next === "<" || next === ">" || next === "&") return false;
      this.index += 1;
      return this.readTarget() !== null;
    }
    this.index += this.line[this.index] === "&" ? 2 : 1;
    if (this.line[this.index] === ">") this.index += 1;
    if (this.line[this.index] === "|") return false;
    if (this.line[this.index] === "&") {
      this.index += 1;
      return /^\d+$/.test(this.readTarget() ?? "");
    }
    return this.readTarget() === "/dev/null";
  }

  private readTarget(): string | null {
    while (this.line[this.index] === " " || this.line[this.index] === "\t") this.index += 1;
    const start = this.index;
    while (this.index < this.line.length && !TARGET_END.test(this.line[this.index])) {
      this.index += 1;
    }
    const target = this.line.slice(start, this.index);
    if (!PLAIN_TARGET.test(target)) return null;
    this.redirectTargets.push(target);
    return target;
  }

  private endWord(): void {
    if (this.inWord) this.words.push({ text: this.word, globbed: this.globbed });
    this.word = "";
    this.inWord = false;
    this.quoted = false;
    this.globbed = false;
  }

  private endSegment(): boolean {
    this.endWord();
    if (this.words.length === 0) return false;
    this.segments.push(this.words);
    this.words = [];
    return true;
  }
}
