/**
 * Decides whether a shell command line only reads files inside the agent's folder. Used to
 * auto-approve shell commands for agents in a read-only mode, so the answer must never be "yes" for
 * a command that can change something or read outside that folder: anything this module does not
 * understand is not read-only.
 *
 * The check parses one line of POSIX shell: words, quotes, `|`, `||`, `&&` and `;`. It refuses
 * any `$` outside single quotes (the shell is persistent, so a variable can hold anything),
 * command substitution, subshells, background jobs, comments, environment assignments, unquoted
 * globs, and redirects other than to `/dev/null`, to another descriptor, or from a file.
 * Every command in the line must be on the allowlist below and pass its argument check.
 *
 * Paths: the command runs in the agent's folder (OMP's `cwd` argument is held there by
 * `providers/omp/read-only-guard-extension.ts`), so only relative paths that stay below it pass.
 * Absolute paths, `~`, `..` segments and `cd` ask, and so do the credential names in
 * `SECRET_PATHS` (`.env`, SSH keys, ...), which can sit inside the folder too.
 */

type ArgumentCheck = (args: readonly string[]) => boolean;

const ANY_ARGUMENTS: ArgumentCheck = () => true;

const READ_ONLY_COMMANDS: ReadonlyMap<string, ArgumentCheck> = new Map<string, ArgumentCheck>([
  ...[
    "basename",
    "cat",
    "cksum",
    "cmp",
    "column",
    "comm",
    "cut",
    "df",
    "dirname",
    "du",
    "echo",
    "false",
    "fold",
    "free",
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
  ["ps", (args) => !psPrintsEnvironment(args, process.platform)],
  // `env` and `$ENV` print the environment; -i/--in-place writes the input file back; -f reads
  // the program from a file.
  [
    "jq",
    (args) =>
      !args.some((arg) => /env/i.test(arg)) && !hasFlag(args, "if", ["--in-place", "--from-file"]),
  ],
  // -v assigns a shell variable, which outlives the command in a persistent shell.
  ["printf", (args) => !hasFlag(args, "v", [])],
  // -C compiles a magic file next to the input.
  ["file", (args) => !hasFlag(args, "C", ["--compile"])],
  // -s sets the clock.
  ["date", (args) => !hasFlag(args, "s", ["--set"])],
  // -o writes the output to a file; --compress-program runs a program.
  ["sort", (args) => !hasFlag(args, "o", ["--output", "--compress-program"])],
  // A second operand is an output file.
  ["uniq", (args) => operands(args).length <= 1],
  // -o writes the listing to a file; -R writes an HTML index into every directory.
  ["tree", (args) => !hasFlag(args, "oR", [])],
  ["find", (args) => !args.some((arg) => FIND_ACTIONS.some((action) => arg.startsWith(action)))],
  // Recursive reads open every file below a directory, `.env` files included.
  ...["grep", "egrep", "fgrep"].map((name): [string, ArgumentCheck] => [
    name,
    (args) => !hasFlag(args, "rRd", ["--recursive", "--dereference-recursive", "--directories"]),
  ]),
  ["diff", (args) => !hasFlag(args, "rN", ["--recursive", "--new-file"])],
  // rg skips hidden and ignored files (where `.env` lives) unless told otherwise; --pre and
  // --search-zip run programs.
  [
    "rg",
    (args) =>
      !hasFlag(args, "u.Lz", [
        "--pre",
        "--hidden",
        "--no-ignore",
        "--unrestricted",
        "--follow",
        "--search-zip",
      ]),
  ],
  ["fd", (args) => !hasFlag(args, "xX", ["--exec", "--exec-batch"])],
  ["git", isReadOnlyGitCommand],
]);

const FIND_ACTIONS = [
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fls",
  "-files0-from",
];

/** Long options any command refuses: they read the list of files to open from a file. */
const REFUSED_LONG_OPTIONS = ["--files0-from"];

/** `e` without a dash (BSD style), `-E`, and `-e` on macOS print each process's environment. */
function psPrintsEnvironment(args: readonly string[], platform: NodeJS.Platform): boolean {
  return args.some((arg) => {
    if (!arg.startsWith("-")) return arg.includes("e");
    if (arg.startsWith("--")) return false;
    return arg.includes("E") || (platform === "darwin" && arg.includes("e"));
  });
}

/** The arguments that are not options: words without a leading dash, and every word after `--`. */
function operands(args: readonly string[]): string[] {
  const end = args.indexOf("--");
  const before = end < 0 ? args : args.slice(0, end);
  const after = end < 0 ? [] : args.slice(end + 1);
  return [...before.filter((arg) => !arg.startsWith("-") || arg === "-"), ...after];
}

/**
 * True when `args` holds one of the short flags (as its own argument or inside a cluster like
 * `-bo`) or a long flag, with or without `=value`. GNU and git accept any unambiguous prefix of a
 * long option (`--outp` for `--output`), and some tools have families (`--no-ignore-vcs`), so a
 * long option matches when either name starts with the other. Over-matches on purpose.
 */
function hasFlag(
  args: readonly string[],
  shortFlags: string,
  longFlags: readonly string[],
): boolean {
  return args.some((arg) => {
    if (arg.startsWith("--")) {
      const name = arg.split("=", 1)[0];
      return (
        name.length > 2 && longFlags.some((flag) => flag.startsWith(name) || name.startsWith(flag))
      );
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

// Listing flags only: any other word names a branch to create, move or delete.
const GIT_BRANCH_LIST_FLAGS = new Set([
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--show-current",
  "--merged",
  "--no-merged",
  "--color",
  "--no-color",
  "--column",
  "--no-column",
]);
const GIT_BRANCH_LIST_VALUE_FLAGS = ["--sort=", "--format=", "--contains=", "--points-at="];

/**
 * Keys `git config --get` may print. Anything else can hold a token: remote URLs, `http.*`
 * headers, credential helpers.
 */
const GIT_CONFIG_READABLE_KEY =
  /^(?:user\.(?:name|email)|core\.[a-z]+|init\.defaultbranch|pull\.rebase|push\.default)$/i;

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
    "log",
    "ls-files",
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
  // --no-index and --untracked search files git does not track, `.env` files included.
  ["grep", (args) => GIT_HISTORY_CHECK(args) && !hasFlag(args, "", ["--no-index", "--untracked"])],
  ["for-each-ref", ANY_ARGUMENTS],
  [
    "branch",
    (args) =>
      args.every(
        (arg) =>
          GIT_BRANCH_LIST_FLAGS.has(arg) ||
          GIT_BRANCH_LIST_VALUE_FLAGS.some((flag) => arg.startsWith(flag)),
      ),
  ],
  [
    "tag",
    (args) =>
      args.length === 0 ||
      ((args[0] === "-l" || args[0] === "--list") &&
        args.slice(1).every((arg) => !arg.startsWith("-"))),
  ],
  // Remote names only: URLs can carry a token.
  ["remote", (args) => args.length === 0],
  [
    "config",
    (args) =>
      args.length === 2 &&
      (args[0] === "get" || args[0] === "--get") &&
      GIT_CONFIG_READABLE_KEY.test(args[1]),
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
  // set an alias, pager or hook command. The paths they take pass the same path check as any word.
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
 * Credential names that can sit inside the agent's folder. A word or redirect target matching one
 * of these makes the command ask, even when it only reads.
 */
const SECRET_PATHS: readonly RegExp[] = [
  // Paseo daemon home, SSH keys, GitHub CLI auth, OMP's credential vault.
  /(?:^|[/=])\.paseo(?:\/|$)/,
  /(?:^|[/=])\.ssh(?:\/|$)/,
  /(?:^|[/=])\.config\/gh(?:\/|$)/,
  /(?:^|[/=])\.omp\/agent(?:\/|$)/,
  /(?:^|[/=])(?:agent\.db|auth\.json)/,
  /(?:^|[/=])\.env(?:\.[^/]*)?$/,
  /(?:^|[/=])id_(?:rsa|ecdsa|ed25519|dsa)/,
  /\.(?:pem|key|token)$/,
];

function namesSecretPath(word: string): boolean {
  return SECRET_PATHS.some((pattern) => pattern.test(word));
}

// A path that starts at `/` or `~`, alone or as an option value (`--git-dir=/x`, `HEAD:/x`).
const ROOTED_PATH = /(?:^|[=:,])[/~]/;
// A `..` segment, alone or as an option value.
const PARENT_SEGMENT = /(?:^|[/=:,])\.\.(?:$|[/:,])/;

/**
 * True when a word may name a path outside the agent's folder. `/dev/null` is the one absolute
 * path allowed. A short option with a value glued on (`-f/etc/x`) counts when the value holds a
 * `/` or `~`.
 */
function mayLeaveFolder(word: string): boolean {
  if (word === "/dev/null") return false;
  if (ROOTED_PATH.test(word) || PARENT_SEGMENT.test(word)) return true;
  return /^-[^-]/.test(word) && /[/~]/.test(word);
}

function refusedWord(word: string): boolean {
  return (
    mayLeaveFolder(word) ||
    namesSecretPath(word) ||
    REFUSED_LONG_OPTIONS.some((option) => word.startsWith(option))
  );
}

export function isReadOnlyShellCommand(command: string): boolean {
  const parser = new ShellLineParser(command);
  const segments = parser.parse();
  if (!segments || segments.length === 0) return false;
  if (parser.redirectTargets.some(refusedWord)) return false;
  return segments.every((words) => {
    if (words.some((word) => word.globbed || refusedWord(word.text))) return false;
    const [name, ...args] = words;
    if (name === undefined || name.text.includes("=")) return false;
    const check = READ_ONLY_COMMANDS.get(name.text);
    return check !== undefined && check(args.map((arg) => arg.text));
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
// What may follow a redirect target: the end of the word.
const TARGET_FOLLOWERS = " \t|&;<>";

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
    // A quote or backslash right after the target glues more text onto it (`>&1'x'` writes `1x`).
    const next = this.line[this.index];
    if (next !== undefined && !TARGET_FOLLOWERS.includes(next)) return null;
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
