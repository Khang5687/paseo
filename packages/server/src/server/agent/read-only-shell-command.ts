/**
 * Decides whether a shell command line only reads files inside the agent's folder. Used to
 * auto-approve shell commands for agents in a read-only mode, so the answer must never be "yes" for
 * a command that can change something, run a program it was not asked to, or read outside that
 * folder: anything this module does not understand is not read-only.
 *
 * Deny by default, at every level:
 * - The line: one line of POSIX shell with words, quotes, `|`, `||`, `&&` and `;`. Any `$`
 *   outside single quotes, command substitution, subshells, background jobs, comments, environment
 *   assignments, unquoted globs, and redirects other than to `/dev/null`, to another descriptor, or
 *   from a file ask.
 * - Commands: only the commands in `READ_ONLY_COMMANDS`.
 * - Options: each command lists the exact options it accepts. An option that is not on its list
 *   asks, abbreviations included: OMP runs most of these commands through its own builtins
 *   (`crates/pi-builtins` in oh-my-pi), which accept abbreviated long options like GNU does.
 * - Paths: every operand and option value that can name a file is resolved with `realpath` (a
 *   missing path through its nearest existing parent) and must stay inside the agent's folder.
 *   `scheme://` words (OMP's builtins open those as virtual files), `~`, `..`, `@file` and the
 *   credential names in `SECRET_NAMES` ask. Words a command never opens (patterns, formats, jq
 *   programs) are marked as text and skip the path check.
 * - The folder: `/`, the home folder, folders above it and dot-folders under it (`~/.config`)
 *   never auto-approve.
 * - git: only the folder's own repository, with no option that picks another one, and only when
 *   that repository's own config and hooks cannot make git run a program (`gitRepoIsSafe`).
 *
 * The shell is persistent, so an alias, function or export from an earlier command can change
 * what a later one does. The caller stops auto-approving once any shell command ran that this
 * module did not approve (`providers/omp/agent.ts`); OMP's `cwd` argument is held at the folder by
 * `providers/omp/read-only-guard-extension.ts`.
 */
import { execFile } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function isReadOnlyShellCommand(line: string, folder: string): Promise<boolean> {
  const parser = new ShellLineParser(line);
  const segments = parser.parse();
  if (!segments || segments.length === 0) return false;
  const paths: PathUse[] = parser.inputTargets.map((word) => ({ word }));
  let runsGit = false;
  for (const segment of segments) {
    if (segment.words.some((word) => word.globbed)) return false;
    const [name, ...args] = segment.words.map((word) => word.text);
    const check = name === undefined ? undefined : READ_ONLY_COMMANDS.get(name);
    const plan = check?.(args, { afterPipe: segment.afterPipe });
    if (!plan) return false;
    paths.push(...plan.paths);
    runsGit ||= plan.runsGit === true;
  }
  const root = await agentFolderRoot(folder);
  if (root === null) return false;
  for (const use of paths) {
    if (!(await pathStaysInFolder(use, root))) return false;
  }
  return !runsGit || (await gitRepoIsSafe(root));
}

// ---------------------------------------------------------------------------
// Command plans: what each command may be given, and which of its words name files.
// ---------------------------------------------------------------------------

interface PathUse {
  word: string;
  /** The command reads the whole file; a directory would make it read everything below it. */
  regularFile?: boolean;
}

interface CommandPlan {
  paths: PathUse[];
  runsGit?: boolean;
}

interface CommandContext {
  /** The command reads the previous command's output (`a | b`). */
  afterPipe: boolean;
}

type CommandCheck = (args: readonly string[], context: CommandContext) => CommandPlan | null;

interface OptionSpec {
  /** Short options without a value. */
  flags?: string;
  /** Short options with a value, glued (`-n5`) or as the next word. */
  valued?: string;
  /** Short options with an optional value, glued only (`-uno`). */
  optional?: string;
  /** `-20` is a count (head, tail, git log). */
  numeric?: boolean;
  /** Long options without a value, exact names. */
  long?: readonly string[];
  /** Long options with a value (`--x=v` or `--x v`). */
  longValued?: readonly string[];
  /** Long options with an optional value, glued only (`--color`, `--color=auto`). */
  longOptional?: readonly string[];
  /** Long options with two values (`jq --arg name value`). */
  longPair?: readonly string[];
  /** Options whose value names a file the command reads; every other value is text. */
  pathValued?: readonly string[];
}

interface ParsedOption {
  name: string;
  value?: string;
}

interface ParsedArgs {
  options: ParsedOption[];
  operands: string[];
}

/**
 * Splits `args` by `spec`, or returns null for any option `spec` does not list. Options may come
 * after operands (GNU and git permute them); everything after `--` is an operand.
 */
function parseOptions(args: readonly string[], spec: OptionSpec): ParsedArgs | null {
  const options: ParsedOption[] = [];
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(arg)) {
      options.push({ name: "-#", value: arg.slice(1) });
      continue;
    }
    const last = arg.startsWith("--")
      ? parseLongOption(args, index, spec, options)
      : parseShortOptions(args, index, spec, options);
    if (last === null) return null;
    index = last;
  }
  return { options, operands };
}

/** Reads the `--name[=value]` at `args[index]`; returns the index of the last arg it used. */
function parseLongOption(
  args: readonly string[],
  index: number,
  spec: OptionSpec,
  options: ParsedOption[],
): number | null {
  const arg = args[index];
  const equals = arg.indexOf("=");
  const name = equals < 0 ? arg : arg.slice(0, equals);
  const glued = equals < 0 ? undefined : arg.slice(equals + 1);
  if (spec.long?.includes(name) && glued === undefined) {
    options.push({ name });
    return index;
  }
  if (spec.longOptional?.includes(name)) {
    options.push({ name, value: glued });
    return index;
  }
  if (spec.longValued?.includes(name)) {
    const value = glued ?? args[index + 1];
    if (value === undefined) return null;
    options.push({ name, value });
    return glued === undefined ? index + 1 : index;
  }
  if (spec.longPair?.includes(name) && glued === undefined) {
    const first = args[index + 1];
    const second = args[index + 2];
    if (first === undefined || second === undefined) return null;
    options.push({ name, value: first }, { name, value: second });
    return index + 2;
  }
  return null;
}

/** Reads the cluster of letters at `args[index]`; returns the index of the last arg it used. */
function parseShortOptions(
  args: readonly string[],
  index: number,
  spec: OptionSpec,
  options: ParsedOption[],
): number | null {
  const arg = args[index];
  for (let at = 1; at < arg.length; at += 1) {
    const letter = arg[at];
    const rest = arg.slice(at + 1);
    if (spec.flags?.includes(letter)) {
      options.push({ name: `-${letter}` });
      continue;
    }
    if (spec.optional?.includes(letter)) {
      options.push({ name: `-${letter}`, value: rest || undefined });
      return index;
    }
    if (spec.valued?.includes(letter)) {
      const value = rest || args[index + 1];
      if (value === undefined) return null;
      options.push({ name: `-${letter}`, value });
      return rest ? index : index + 1;
    }
    return null;
  }
  return index;
}

function hasOption(parsed: ParsedArgs, ...names: string[]): boolean {
  return parsed.options.some((option) => names.includes(option.name));
}

function pathValues(parsed: ParsedArgs, spec: OptionSpec): PathUse[] {
  return parsed.options.flatMap((option) =>
    option.value !== undefined && spec.pathValued?.includes(option.name)
      ? [{ word: option.value }]
      : [],
  );
}

type OperandRule = (parsed: ParsedArgs, context: CommandContext) => PathUse[] | null;

const PATH_OPERANDS: OperandRule = (parsed) => parsed.operands.map((word) => ({ word }));
const TEXT_OPERANDS: OperandRule = () => [];

function command(spec: OptionSpec, operandRule: OperandRule = PATH_OPERANDS): CommandCheck {
  return (args, context) => {
    const parsed = parseOptions(args, spec);
    if (!parsed) return null;
    const operands = operandRule(parsed, context);
    return operands && { paths: [...operands, ...pathValues(parsed, spec)] };
  };
}

function mergeSpecs(...specs: OptionSpec[]): OptionSpec {
  const join = (key: "flags" | "valued" | "optional") =>
    specs.map((spec) => spec[key] ?? "").join("");
  const all = (key: "long" | "longValued" | "longOptional" | "longPair" | "pathValued") =>
    specs.flatMap((spec) => spec[key] ?? []);
  return {
    flags: join("flags"),
    valued: join("valued"),
    optional: join("optional"),
    numeric: specs.some((spec) => spec.numeric),
    long: all("long"),
    longValued: all("longValued"),
    longOptional: all("longOptional"),
    longPair: all("longPair"),
    pathValued: all("pathValued"),
  };
}

/** grep-style operands: the first is the pattern unless one came from `-e` or `-f`. */
function patternThenFiles(patternOptions: readonly string[], regularFile: boolean): OperandRule {
  return (parsed) => {
    const files = hasOption(parsed, ...patternOptions) ? parsed.operands : parsed.operands.slice(1);
    return files.map((word) => ({ word, regularFile }));
  };
}

const GREP_SPEC: OptionSpec = {
  flags: "ivnclLwxoqshHEFGPaIzZbTUy",
  valued: "eABCmf",
  long: [
    "--ignore-case",
    "--no-ignore-case",
    "--invert-match",
    "--line-number",
    "--count",
    "--files-with-matches",
    "--files-without-match",
    "--word-regexp",
    "--line-regexp",
    "--only-matching",
    "--quiet",
    "--silent",
    "--no-messages",
    "--no-filename",
    "--with-filename",
    "--extended-regexp",
    "--fixed-strings",
    "--basic-regexp",
    "--perl-regexp",
    "--text",
    "--byte-offset",
    "--initial-tab",
    "--null",
    "--null-data",
    "--line-buffered",
  ],
  longOptional: ["--color", "--colour"],
  longValued: [
    "--regexp",
    "--file",
    "--after-context",
    "--before-context",
    "--context",
    "--max-count",
    "--label",
    "--binary-files",
  ],
  pathValued: ["-f", "--file"],
};
// Without -r grep reads only the files it is given; a directory would be read as a file.
const GREP = command(GREP_SPEC, patternThenFiles(["-e", "-f", "--regexp", "--file"], true));

const RG_SPEC: OptionSpec = {
  flags: "iswxvnNlcoFUHIqaSp0",
  valued: "efgtTABCmrdjM",
  long: [
    "--ignore-case",
    "--smart-case",
    "--case-sensitive",
    "--word-regexp",
    "--line-regexp",
    "--invert-match",
    "--line-number",
    "--no-line-number",
    "--files-with-matches",
    "--files-without-match",
    "--count",
    "--count-matches",
    "--only-matching",
    "--fixed-strings",
    "--multiline",
    "--multiline-dotall",
    "--with-filename",
    "--no-filename",
    "--quiet",
    "--text",
    "--null",
    "--null-data",
    "--pcre2",
    "--json",
    "--vimgrep",
    "--heading",
    "--no-heading",
    "--column",
    "--no-column",
    "--trim",
    "--stats",
    "--files",
    "--type-list",
    "--no-messages",
    "--byte-offset",
    "--crlf",
    "--passthru",
    "--pretty",
    "--line-buffered",
    "--block-buffered",
  ],
  longValued: [
    "--regexp",
    "--file",
    "--glob",
    "--iglob",
    "--type",
    "--type-not",
    "--max-depth",
    "--max-count",
    "--after-context",
    "--before-context",
    "--context",
    "--replace",
    "--sort",
    "--sortr",
    "--threads",
    "--max-columns",
    "--max-filesize",
    "--encoding",
    "--engine",
    "--context-separator",
    "--color",
  ],
  pathValued: ["-f", "--file"],
};
// rg searches a directory recursively, reading every file it does not skip (`credentials.json`,
// `*.pem` and `*.tfstate` are neither hidden nor always ignored), so a search needs file operands
// or piped input. `--files` lists names only.
const RG: CommandCheck = (args, context) => {
  const parsed = parseOptions(args, RG_SPEC);
  if (!parsed) return null;
  const options = pathValues(parsed, RG_SPEC);
  if (hasOption(parsed, "--files")) {
    return { paths: [...parsed.operands.map((word) => ({ word })), ...options] };
  }
  if (hasOption(parsed, "--type-list")) {
    return parsed.operands.length === 0 ? { paths: options } : null;
  }
  const files = patternThenFiles(["-e", "-f", "--regexp", "--file"], true)(parsed, context) ?? [];
  if (files.length === 0 && !context.afterPipe) return null;
  return { paths: [...files, ...options] };
};

const FD_SPEC: OptionSpec = {
  flags: "HIsiFagpq0u",
  valued: "tedEcjS",
  long: [
    "--hidden",
    "--no-ignore",
    "--no-ignore-vcs",
    "--unrestricted",
    "--case-sensitive",
    "--ignore-case",
    "--glob",
    "--fixed-strings",
    "--absolute-path",
    "--full-path",
    "--print0",
    "--quiet",
    "--show-errors",
    "--one-file-system",
    "--prune",
  ],
  longValued: [
    "--type",
    "--extension",
    "--max-depth",
    "--min-depth",
    "--exact-depth",
    "--exclude",
    "--color",
    "--threads",
    "--size",
    "--changed-within",
    "--changed-before",
    "--max-results",
  ],
};
// Lists names only, so directories are fine; the first operand is the pattern.
const FD = command(FD_SPEC, (parsed) => parsed.operands.slice(1).map((word) => ({ word })));

const FIND_PRIMARIES = new Set([
  "-print",
  "-print0",
  "-ls",
  "-empty",
  "-not",
  "!",
  "-o",
  "-or",
  "-a",
  "-and",
  ",",
  "(",
  ")",
  "-prune",
  "-true",
  "-false",
  "-readable",
  "-writable",
  "-executable",
  "-nouser",
  "-nogroup",
  "-depth",
  "-xdev",
  "-mount",
  "-daystart",
  "-noleaf",
  "-quit",
]);
const FIND_TEXT_TESTS = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
  "-regex",
  "-iregex",
  "-regextype",
  "-type",
  "-xtype",
  "-maxdepth",
  "-mindepth",
  "-mtime",
  "-mmin",
  "-atime",
  "-amin",
  "-ctime",
  "-cmin",
  "-used",
  "-size",
  "-user",
  "-group",
  "-uid",
  "-gid",
  "-perm",
  "-links",
  "-inum",
  "-fstype",
  "-printf",
]);
const FIND_PATH_TESTS = new Set(["-newer", "-anewer", "-cnewer", "-samefile"]);

/** `find [paths] [expression]` with tests and printing only: no -exec, -delete, -fprint, -L. */
const FIND: CommandCheck = (args) => {
  const paths: PathUse[] = [];
  let index = 0;
  while (index < args.length && !/^[-!(]/.test(args[index])) {
    paths.push({ word: args[index] });
    index += 1;
  }
  while (index < args.length) {
    const word = args[index];
    if (FIND_PRIMARIES.has(word)) {
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) return null;
    if (FIND_PATH_TESTS.has(word)) paths.push({ word: value });
    else if (!FIND_TEXT_TESTS.has(word)) return null;
    index += 2;
  }
  return { paths };
};

const TEST_OPERATORS = new Set([
  "!",
  "=",
  "==",
  "!=",
  "-a",
  "-o",
  ..."bcdefghknprstuwxzGLNOS".split("").map((letter) => `-${letter}`),
  "-eq",
  "-ne",
  "-lt",
  "-le",
  "-gt",
  "-ge",
  "-nt",
  "-ot",
  "-ef",
]);
const TEST: CommandCheck = (args) => ({
  paths: args.filter((arg) => !TEST_OPERATORS.has(arg)).map((word) => ({ word })),
});

// `env` and `$ENV` print the environment; modules load files from jq's search path, which lies
// outside the folder.
const JQ_UNSAFE_PROGRAM =
  /\$ENV|\$__|\b(?:env|import|include|input_filename|get_search_list|modulemeta|get_prog_origin|get_jq_origin)\b/;
const JQ_SPEC: OptionSpec = {
  flags: "rcnseajSCMR",
  long: [
    "--raw-output",
    "--raw-output0",
    "--compact-output",
    "--null-input",
    "--slurp",
    "--exit-status",
    "--join-output",
    "--ascii-output",
    "--sort-keys",
    "--color-output",
    "--monochrome-output",
    "--raw-input",
    "--tab",
    "--seq",
  ],
  longValued: ["--indent"],
  longPair: ["--arg", "--argjson"],
};
const JQ = command(JQ_SPEC, (parsed) => {
  const [program, ...files] = parsed.operands;
  if (program !== undefined && JQ_UNSAFE_PROGRAM.test(program)) return null;
  return files.map((word) => ({ word }));
});

// `ps` with its default columns, `-f`, `-l`, `u` and BSD forms prints each process's full command
// line, where tokens are often passed. Only `-o` with columns that hold no arguments.
const PS_SAFE_COLUMN =
  /^(?:pid|ppid|pgid|sid|tty|tt|tname|stat|state|s|user|euser|ruser|uid|euid|ruid|group|gid|comm|ucmd|ucomm|fname|%cpu|pcpu|%mem|pmem|rss|rssize|vsz|sz|etime|etimes|time|cputime|start|stime|lstart|nlwp|psr|pri|ni|nice|wchan|f|c)$/i;
const PS_SPEC: OptionSpec = {
  flags: "eArm",
  valued: "opCuU",
  long: ["--no-headers"],
  longValued: ["--format", "--pid", "--ppid", "--sort", "--user", "--User"],
};
const PS: CommandCheck = (args) => {
  const parsed = parseOptions(args, PS_SPEC);
  if (!parsed || parsed.operands.length > 0) return null;
  const formats = parsed.options.filter(
    (option) => option.name === "-o" || option.name === "--format",
  );
  const columns = formats.flatMap((option) =>
    (option.value ?? "").split(/[\s,]+/).filter((column) => column.length > 0),
  );
  const safe =
    columns.length > 0 && columns.every((column) => PS_SAFE_COLUMN.test(column.split("=", 1)[0]));
  return safe ? { paths: [] } : null;
};

// `date MMDDhhmm` sets the clock; only `+FORMAT` operands print.
const DATE = command(
  {
    flags: "uR",
    optional: "I",
    valued: "d",
    long: ["--utc", "--universal", "--rfc-email"],
    longOptional: ["--iso-8601"],
    longValued: ["--date", "--rfc-3339"],
  },
  (parsed) => (parsed.operands.every((operand) => operand.startsWith("+")) ? [] : null),
);

// A second operand is an output file.
const UNIQ = command(
  {
    flags: "cdDuiz",
    valued: "fsw",
    long: ["--count", "--repeated", "--unique", "--ignore-case", "--zero-terminated"],
    longOptional: ["--all-repeated", "--group"],
    longValued: ["--skip-fields", "--skip-chars", "--check-chars"],
  },
  (parsed) => (parsed.operands.length <= 1 ? PATH_OPERANDS(parsed, { afterPipe: false }) : null),
);

// Comparing two folders prints every file that differs, `.env` included.
const DIFF = command(
  {
    flags: "uqsiwbBEZytTap",
    valued: "UCWI",
    long: [
      "--brief",
      "--report-identical-files",
      "--ignore-case",
      "--ignore-all-space",
      "--ignore-space-change",
      "--ignore-blank-lines",
      "--ignore-tab-expansion",
      "--ignore-trailing-space",
      "--side-by-side",
      "--expand-tabs",
      "--initial-tab",
      "--text",
      "--show-c-function",
      "--minimal",
      "--strip-trailing-cr",
      "--suppress-common-lines",
      "--left-column",
      "--speed-large-files",
    ],
    longOptional: ["--color", "--unified", "--context"],
    longValued: ["--width", "--label", "--tabsize", "--ignore-matching-lines"],
  },
  (parsed) =>
    parsed.operands.length === 2
      ? parsed.operands.map((word) => ({ word, regularFile: true }))
      : null,
);

const HEAD_TAIL_SPEC: OptionSpec = {
  flags: "qvz",
  valued: "nc",
  numeric: true,
  long: ["--quiet", "--silent", "--verbose", "--zero-terminated"],
  longValued: ["--lines", "--bytes"],
};

const CHECKSUM_SPEC: OptionSpec = {
  flags: "btz",
  long: ["--binary", "--text", "--tag", "--zero", "--untagged"],
};

const READ_ONLY_COMMANDS: ReadonlyMap<string, CommandCheck> = new Map<string, CommandCheck>([
  ["true", command({}, TEXT_OPERANDS)],
  ["false", command({}, TEXT_OPERANDS)],
  ["pwd", command({ flags: "LP" }, (parsed) => (parsed.operands.length === 0 ? [] : null))],
  ["whoami", command({}, (parsed) => (parsed.operands.length === 0 ? [] : null))],
  ["nproc", command({ long: ["--all"], longValued: ["--ignore"] }, TEXT_OPERANDS)],
  ["uname", command({ flags: "asnrvmpio" }, TEXT_OPERANDS)],
  ["uptime", command({ flags: "ps", long: ["--pretty", "--since"] }, TEXT_OPERANDS)],
  ["free", command({ flags: "bkmghltwv", long: ["--human", "--total", "--wide"] }, TEXT_OPERANDS)],
  [
    "id",
    command(
      { flags: "ugGnrz", long: ["--user", "--group", "--groups", "--name", "--real", "--zero"] },
      TEXT_OPERANDS,
    ),
  ],
  ["which", command({ flags: "a" }, TEXT_OPERANDS)],
  ["type", command({ flags: "atpPf" }, TEXT_OPERANDS)],
  ["echo", command({ flags: "neE" }, TEXT_OPERANDS)],
  // -v assigns a shell variable, which outlives the command in a persistent shell.
  ["printf", command({}, TEXT_OPERANDS)],
  ["seq", command({ flags: "w", valued: "sf" }, TEXT_OPERANDS)],
  [
    "basename",
    command(
      { flags: "az", valued: "s", long: ["--multiple", "--zero"], longValued: ["--suffix"] },
      TEXT_OPERANDS,
    ),
  ],
  ["dirname", command({ flags: "z", long: ["--zero"] }, TEXT_OPERANDS)],
  // tr only reads standard input; its operands are character sets.
  [
    "tr",
    command(
      {
        flags: "cCdst",
        long: ["--complement", "--delete", "--squeeze-repeats", "--truncate-set1"],
      },
      TEXT_OPERANDS,
    ),
  ],
  ["date", DATE],
  ["test", TEST],
  [
    "cat",
    command({
      flags: "nbAeEstTvu",
      long: [
        "--number",
        "--number-nonblank",
        "--show-all",
        "--show-ends",
        "--show-tabs",
        "--show-nonprinting",
        "--squeeze-blank",
      ],
    }),
  ],
  ["head", command(HEAD_TAIL_SPEC)],
  ["tail", command(HEAD_TAIL_SPEC)],
  [
    "wc",
    command({
      flags: "lwcmL",
      long: ["--lines", "--words", "--bytes", "--chars", "--max-line-length"],
      longValued: ["--total"],
    }),
  ],
  [
    "ls",
    command({
      flags: "aAlhR1trSdFpisnCxXvUcuogGNQBkmZ",
      valued: "IwT",
      long: [
        "--all",
        "--almost-all",
        "--human-readable",
        "--recursive",
        "--reverse",
        "--directory",
        "--inode",
        "--size",
        "--numeric-uid-gid",
        "--group-directories-first",
        "--full-time",
        "--literal",
        "--quote-name",
        "--no-group",
        "--ignore-backups",
        "--si",
        "--author",
        "--escape",
        "--hide-control-chars",
        "--show-control-chars",
      ],
      longOptional: ["--color", "--classify"],
      longValued: [
        "--sort",
        "--time",
        "--time-style",
        "--format",
        "--ignore",
        "--hide",
        "--width",
        "--block-size",
        "--indicator-style",
        "--quoting-style",
      ],
    }),
  ],
  [
    "tree",
    command({
      flags: "adfiFnsphCuDgJX",
      valued: "LIP",
      long: ["--noreport", "--dirsfirst", "--gitignore", "--prune", "--du", "--si"],
      longValued: ["--charset", "--sort", "--filelimit"],
    }),
  ],
  [
    "du",
    command({
      flags: "ahcskmbxl",
      valued: "dBt",
      long: [
        "--all",
        "--human-readable",
        "--total",
        "--summarize",
        "--apparent-size",
        "--bytes",
        "--one-file-system",
        "--si",
        "--count-links",
        "--inodes",
      ],
      longValued: ["--max-depth", "--block-size", "--threshold", "--exclude"],
    }),
  ],
  [
    "df",
    command({
      flags: "hkTiaPlH",
      valued: "tx",
      long: [
        "--human-readable",
        "--print-type",
        "--inodes",
        "--all",
        "--local",
        "--portability",
        "--total",
        "--si",
      ],
      longOptional: ["--output"],
      longValued: ["--block-size", "--type", "--exclude-type"],
    }),
  ],
  [
    "stat",
    command({
      flags: "LftF",
      valued: "c",
      long: ["--dereference", "--file-system", "--terse"],
      longValued: ["--format", "--printf"],
    }),
  ],
  [
    "file",
    command({
      flags: "bLizkhsN",
      long: [
        "--brief",
        "--mime",
        "--mime-type",
        "--mime-encoding",
        "--dereference",
        "--no-dereference",
        "--keep-going",
      ],
    }),
  ],
  [
    "readlink",
    command({
      flags: "femnqsvz",
      long: [
        "--canonicalize",
        "--canonicalize-existing",
        "--canonicalize-missing",
        "--no-newline",
        "--quiet",
        "--silent",
        "--verbose",
        "--zero",
      ],
    }),
  ],
  [
    "realpath",
    command({
      flags: "emLPqsz",
      long: [
        "--canonicalize-existing",
        "--canonicalize-missing",
        "--logical",
        "--physical",
        "--quiet",
        "--strip",
        "--no-symlinks",
        "--zero",
      ],
    }),
  ],
  [
    "cut",
    command({
      flags: "snz",
      valued: "dfcb",
      long: ["--complement", "--only-delimited", "--zero-terminated"],
      longValued: ["--delimiter", "--fields", "--characters", "--bytes", "--output-delimiter"],
    }),
  ],
  [
    "tac",
    command({
      flags: "rb",
      valued: "s",
      long: ["--before", "--regex"],
      longValued: ["--separator"],
    }),
  ],
  ["rev", command({})],
  ["nl", command({ flags: "p", valued: "bdfhilnsvw" })],
  [
    "fold",
    command({ flags: "bs", valued: "w", long: ["--bytes", "--spaces"], longValued: ["--width"] }),
  ],
  [
    "column",
    command({
      flags: "tnxe",
      valued: "scoN",
      long: ["--table", "--fillrows"],
      longValued: ["--separator", "--output-separator", "--table-columns", "--output-width"],
    }),
  ],
  [
    "paste",
    command({
      flags: "sz",
      valued: "d",
      long: ["--serial", "--zero-terminated"],
      longValued: ["--delimiters"],
    }),
  ],
  [
    "join",
    command({
      flags: "iz",
      valued: "tjoaev12",
      long: ["--ignore-case", "--nocheck-order", "--check-order", "--header", "--zero-terminated"],
    }),
  ],
  [
    "comm",
    command({
      flags: "123z",
      long: ["--check-order", "--nocheck-order", "--total", "--zero-terminated"],
      longValued: ["--output-delimiter"],
    }),
  ],
  [
    "cmp",
    command({
      flags: "bls",
      valued: "in",
      long: ["--print-bytes", "--verbose", "--quiet", "--silent"],
      longValued: ["--ignore-initial", "--bytes"],
    }),
  ],
  // No -c/--check: a checklist names the files to open.
  ["cksum", command({ ...CHECKSUM_SPEC, valued: "al", longValued: ["--algorithm", "--length"] })],
  ["md5sum", command(CHECKSUM_SPEC)],
  ["sha1sum", command(CHECKSUM_SPEC)],
  ["sha256sum", command(CHECKSUM_SPEC)],
  ["sha512sum", command(CHECKSUM_SPEC)],
  [
    "od",
    command({
      flags: "abcdfilosxv",
      valued: "AjNtwS",
      long: ["--output-duplicates"],
      longOptional: ["--width", "--strings"],
      longValued: ["--address-radix", "--skip-bytes", "--read-bytes", "--format"],
    }),
  ],
  ["hexdump", command({ flags: "bcCdovx", valued: "nse" })],
  [
    "strings",
    command({
      flags: "afdw",
      valued: "nte",
      long: ["--all", "--print-file-name", "--data", "--include-all-whitespace"],
      longValued: ["--bytes", "--radix", "--encoding", "--output-separator"],
    }),
  ],
  // No -o/--output (writes), -T (temporary files), --compress-program (runs a program),
  // --files0-from or --random-source (read a file the check does not see).
  [
    "sort",
    command({
      flags: "nrufhVbsgMzmRdi",
      valued: "ktS",
      long: [
        "--numeric-sort",
        "--reverse",
        "--unique",
        "--ignore-case",
        "--human-numeric-sort",
        "--version-sort",
        "--ignore-leading-blanks",
        "--stable",
        "--general-numeric-sort",
        "--month-sort",
        "--zero-terminated",
        "--merge",
        "--random-sort",
        "--dictionary-order",
        "--ignore-nonprinting",
      ],
      longOptional: ["--check"],
      longValued: ["--key", "--field-separator", "--buffer-size", "--parallel", "--sort"],
    }),
  ],
  ["uniq", UNIQ],
  ["diff", DIFF],
  ["grep", GREP],
  ["egrep", GREP],
  ["fgrep", GREP],
  ["rg", RG],
  ["fd", FD],
  ["find", FIND],
  ["jq", JQ],
  ["ps", PS],
  ["git", gitCommand],
]);

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/**
 * Global options that change nothing about which repository git uses. `-C`, `--git-dir`,
 * `--work-tree`, `-c`, `--exec-path` and every other global option ask: they pick another
 * repository (whose config can run programs) or set config.
 */
const GIT_GLOBAL_OPTIONS = new Set(["--no-pager", "-P", "--no-optional-locks"]);

/** Diff output options. `--ext-diff`, `--textconv`, `--output` and `-O` are left out. */
const GIT_DIFF_SPEC: OptionSpec = {
  flags: "puswbRzMBaW",
  valued: "USG",
  long: [
    "--patch",
    "--no-patch",
    "--numstat",
    "--shortstat",
    "--summary",
    "--name-only",
    "--name-status",
    "--raw",
    "--patch-with-stat",
    "--patch-with-raw",
    "--minimal",
    "--patience",
    "--histogram",
    "--no-renames",
    "--text",
    "--ignore-all-space",
    "--ignore-space-change",
    "--ignore-blank-lines",
    "--ignore-space-at-eol",
    "--ignore-cr-at-eol",
    "--no-color",
    "--full-index",
    "--binary",
    "--check",
    "--no-ext-diff",
    "--no-textconv",
    "--compact-summary",
    "--exit-code",
    "--quiet",
    "--pickaxe-all",
    "--pickaxe-regex",
    "--irreversible-delete",
    "--no-prefix",
    "--function-context",
  ],
  longOptional: [
    "--color",
    "--stat",
    "--dirstat",
    "--word-diff",
    "--color-words",
    "--find-renames",
    "--find-copies",
    "--abbrev",
    "--color-moved",
  ],
  longValued: [
    "--unified",
    "--diff-filter",
    "--inter-hunk-context",
    "--stat-width",
    "--stat-count",
    "--src-prefix",
    "--dst-prefix",
    "--line-prefix",
    "--diff-algorithm",
  ],
};

/** History options. `--show-signature` (runs gpg) and `--stdin` are left out. */
const GIT_LOG_SPEC: OptionSpec = {
  flags: "iEF",
  valued: "n",
  numeric: true,
  long: [
    "--oneline",
    "--graph",
    "--all",
    "--branches",
    "--tags",
    "--remotes",
    "--no-decorate",
    "--reverse",
    "--first-parent",
    "--merges",
    "--no-merges",
    "--topo-order",
    "--date-order",
    "--author-date-order",
    "--left-right",
    "--cherry-pick",
    "--cherry-mark",
    "--cherry",
    "--boundary",
    "--simplify-by-decoration",
    "--full-history",
    "--dense",
    "--sparse",
    "--follow",
    "--abbrev-commit",
    "--no-abbrev-commit",
    "--parents",
    "--children",
    "--source",
    "--relative-date",
    "--no-notes",
    "--regexp-ignore-case",
    "--extended-regexp",
    "--fixed-strings",
    "--all-match",
    "--invert-grep",
    "--root",
    "--full-diff",
    "--ancestry-path",
    "--not",
  ],
  longOptional: ["--decorate", "--no-walk", "--pretty"],
  longValued: [
    "--max-count",
    "--skip",
    "--since",
    "--after",
    "--until",
    "--before",
    "--author",
    "--committer",
    "--grep",
    "--format",
    "--date",
    "--decorate-refs",
    "--decorate-refs-exclude",
    "--min-parents",
    "--max-parents",
    "--diff-merges",
  ],
};

const GIT_HISTORY_SPEC = mergeSpecs(GIT_DIFF_SPEC, GIT_LOG_SPEC);

const noOperands: OperandRule = (parsed) => (parsed.operands.length === 0 ? [] : null);

const GIT_SUBCOMMANDS: ReadonlyMap<string, CommandCheck> = new Map<string, CommandCheck>([
  // Revisions before `--` and pathspecs after it are all checked as paths; a `rev:path` word is
  // checked as written, so `HEAD:.env` asks.
  ["log", command(GIT_HISTORY_SPEC)],
  ["show", command(GIT_HISTORY_SPEC)],
  ["diff", command(mergeSpecs(GIT_DIFF_SPEC, { long: ["--cached", "--staged", "--merge-base"] }))],
  [
    "diff-tree",
    command(
      mergeSpecs(GIT_DIFF_SPEC, { flags: "rtcm", long: ["--no-commit-id", "--root", "--cc"] }),
    ),
  ],
  ["diff-index", command(mergeSpecs(GIT_DIFF_SPEC, { long: ["--cached"] }))],
  ["diff-files", command(GIT_DIFF_SPEC)],
  ["rev-list", command(mergeSpecs(GIT_LOG_SPEC, { long: ["--count"] }))],
  [
    "shortlog",
    command(
      mergeSpecs(GIT_LOG_SPEC, {
        flags: "sec",
        long: ["--numbered", "--summary", "--email", "--committer"],
        longValued: ["--group"],
      }),
    ),
  ],
  [
    "status",
    command({
      flags: "sbvz",
      optional: "u",
      long: [
        "--short",
        "--branch",
        "--long",
        "--verbose",
        "--show-stash",
        "--ahead-behind",
        "--no-ahead-behind",
        "--renames",
        "--no-renames",
        "--null",
      ],
      longOptional: ["--porcelain", "--untracked-files", "--ignored", "--find-renames"],
    }),
  ],
  [
    "blame",
    command({
      flags: "lstwfnepcMb",
      valued: "L",
      long: [
        "--porcelain",
        "--line-porcelain",
        "--show-name",
        "--show-number",
        "--show-email",
        "--root",
        "--show-stats",
      ],
      longOptional: ["--abbrev"],
      longValued: ["--date"],
    }),
  ],
  [
    "ls-files",
    command({
      flags: "cdmoiskutvfz",
      valued: "x",
      long: [
        "--cached",
        "--deleted",
        "--modified",
        "--others",
        "--ignored",
        "--stage",
        "--killed",
        "--unmerged",
        "--directory",
        "--no-empty-directory",
        "--exclude-standard",
        "--full-name",
        "--error-unmatch",
        "--eol",
        "--deduplicate",
      ],
      longOptional: ["--abbrev"],
      longValued: ["--exclude", "--exclude-per-directory", "--format"],
    }),
  ],
  [
    "ls-tree",
    command({
      flags: "rdtlz",
      long: [
        "--name-only",
        "--name-status",
        "--object-only",
        "--full-name",
        "--full-tree",
        "--long",
      ],
      longOptional: ["--abbrev"],
      longValued: ["--format"],
    }),
  ],
  [
    "rev-parse",
    command({
      flags: "q",
      long: [
        "--show-toplevel",
        "--show-prefix",
        "--show-cdup",
        "--git-dir",
        "--git-common-dir",
        "--absolute-git-dir",
        "--is-inside-work-tree",
        "--is-inside-git-dir",
        "--is-bare-repository",
        "--is-shallow-repository",
        "--verify",
        "--quiet",
        "--symbolic",
        "--symbolic-full-name",
        "--all",
        "--branches",
        "--tags",
        "--remotes",
        "--show-object-format",
      ],
      longOptional: ["--short", "--abbrev-ref"],
    }),
  ],
  ["cat-file", command({ flags: "tspe" })],
  [
    "merge-base",
    command({
      flags: "a",
      long: ["--is-ancestor", "--all", "--octopus", "--independent", "--fork-point"],
    }),
  ],
  [
    "describe",
    command({
      long: [
        "--tags",
        "--all",
        "--always",
        "--long",
        "--exact-match",
        "--first-parent",
        "--contains",
      ],
      longOptional: ["--abbrev", "--dirty", "--broken"],
      longValued: ["--match", "--exclude", "--candidates"],
    }),
  ],
  [
    "show-ref",
    command({
      flags: "sdq",
      long: ["--heads", "--tags", "--branches", "--head", "--dereference", "--verify", "--quiet"],
      longOptional: ["--hash", "--abbrev"],
    }),
  ],
  [
    "for-each-ref",
    command({
      long: ["--ignore-case"],
      longOptional: ["--merged", "--no-merged"],
      longValued: ["--format", "--sort", "--count", "--points-at", "--contains", "--no-contains"],
    }),
  ],
  [
    "name-rev",
    command({
      long: ["--name-only", "--tags", "--always", "--all"],
      longValued: ["--refs", "--exclude"],
    }),
  ],
  ["check-ignore", command({ flags: "vnz", long: ["--verbose", "--non-matching"] })],
  ["check-attr", command({ flags: "az", long: ["--all", "--cached"] })],
  ["count-objects", command({ flags: "vH", long: ["--verbose", "--human-readable"] }, noOperands)],
  ["version", command({ long: ["--build-options"] }, noOperands)],
  [
    "grep",
    command(
      {
        flags: "nilLcwvEFGPhHoqIzaW",
        valued: "eABCmf",
        long: [
          "--line-number",
          "--ignore-case",
          "--files-with-matches",
          "--name-only",
          "--files-without-match",
          "--count",
          "--word-regexp",
          "--invert-match",
          "--extended-regexp",
          "--fixed-strings",
          "--basic-regexp",
          "--perl-regexp",
          "--full-name",
          "--heading",
          "--break",
          "--only-matching",
          "--quiet",
          "--null",
          "--cached",
          "--all-match",
          "--and",
          "--or",
          "--not",
          "--show-function",
          "--function-context",
          "--column",
          "--no-color",
          "--text",
        ],
        longOptional: ["--color"],
        longValued: [
          "--max-depth",
          "--after-context",
          "--before-context",
          "--context",
          "--max-count",
          "--threads",
          "--regexp",
        ],
        pathValued: ["-f"],
      },
      patternThenFiles(["-e", "-f", "--regexp"], false),
    ),
  ],
  // Listing only: any operand names a branch to create, and `--list` is left out with it.
  [
    "branch",
    command(
      {
        flags: "arv",
        long: ["--all", "--remotes", "--verbose", "--show-current", "--no-color", "--no-column"],
        longOptional: ["--color", "--column", "--abbrev"],
        longValued: [
          "--sort",
          "--format",
          "--contains",
          "--no-contains",
          "--points-at",
          "--merged",
          "--no-merged",
        ],
      },
      noOperands,
    ),
  ],
  [
    "tag",
    (args) =>
      args.length === 0 ||
      ((args[0] === "-l" || args[0] === "--list") &&
        args.slice(1).every((arg) => !arg.startsWith("-")))
        ? { paths: [] }
        : null,
  ],
  // Remote names only: URLs can carry a token.
  ["remote", (args) => (args.length === 0 ? { paths: [] } : null)],
  [
    "config",
    (args) =>
      args.length === 2 &&
      (args[0] === "get" || args[0] === "--get") &&
      GIT_CONFIG_READABLE_KEY.test(args[1])
        ? { paths: [] }
        : null,
  ],
  // `git reflog expire` and `delete` write; the default is `show`.
  [
    "reflog",
    (args, context) =>
      args.length === 0 || args[0] === "show" || args[0].startsWith("-")
        ? command(GIT_LOG_SPEC)(args[0] === "show" ? args.slice(1) : args, context)
        : null,
  ],
  [
    "stash",
    (args, context) => {
      if (args[0] === "list") return command(GIT_LOG_SPEC)(args.slice(1), context);
      if (args[0] === "show") return command(GIT_DIFF_SPEC)(args.slice(1), context);
      return null;
    },
  ],
  [
    "worktree",
    (args, context) =>
      args[0] === "list"
        ? command({ flags: "vz", long: ["--porcelain", "--verbose"] }, noOperands)(
            args.slice(1),
            context,
          )
        : null,
  ],
]);

/**
 * Keys `git config --get` may print. Anything else can hold a token: remote URLs, `http.*`
 * headers, credential helpers.
 */
const GIT_CONFIG_READABLE_KEY =
  /^(?:user\.(?:name|email)|core\.[a-z]+|init\.defaultbranch|pull\.rebase|push\.default)$/i;

function gitCommand(args: readonly string[], context: CommandContext): CommandPlan | null {
  let index = 0;
  while (index < args.length && GIT_GLOBAL_OPTIONS.has(args[index])) index += 1;
  const subcommand = args[index];
  const check = subcommand === undefined ? undefined : GIT_SUBCOMMANDS.get(subcommand);
  const plan = check?.(args.slice(index + 1), context);
  return plan ? { paths: plan.paths, runsGit: true } : null;
}

/**
 * Repository config, in the folder's own repository (`local` and `worktree` scope), that makes
 * read-only git commands run a program: fsmonitor and pagers, external diff and textconv drivers,
 * clean/smudge filters, and gpg for `log.showSignature`. The user's global and system config is
 * theirs and trusted; a repository's own config can come from an unpacked archive.
 */
const UNSAFE_REPO_CONFIG = [
  /^core\.(?:fsmonitor|pager)$/,
  /^pager\./,
  /^diff\.external$/,
  /^diff\..+\.(?:textconv|command)$/,
  /^filter\..+\.(?:clean|smudge|process)$/,
  /^log\.showsignature$/,
  /^gpg\.(?:.+\.)?program$/,
];
const FALSE_CONFIG_VALUE = /^(?:false|no|off|0|)$/i;

/** Hooks a read-only command can fire: `git status` refreshes and rewrites the index. */
const READ_TRIGGERED_HOOKS = ["post-index-change", "reference-transaction"];

/**
 * True when git, run in `root`, uses a repository whose own config, hooks and layout cannot make
 * a read-only command run a program or read another repository. Everything that can be planted
 * inside `root` is checked; what lies outside it belongs to the user.
 */
async function gitRepoIsSafe(root: string): Promise<boolean> {
  try {
    const repo = await findRepo(root);
    if (repo === null) return false;

    const config = parseGitConfigList(
      await runGit(root, ["config", "--list", "--show-scope", "--includes", "-z"]),
    );
    const local = config.filter((entry) => entry.scope === "local" || entry.scope === "worktree");
    if (local.some(isUnsafeRepoConfig)) return false;
    if (!(await repoLayoutIsSafe(repo, root, local))) return false;
    if (await hasReadTriggeredHook(repo, root, config)) return false;
    // Read the index only after the config check: reading it runs fsmonitor.
    return !(await hasCheckedOutSubmodule(repo, root));
  } catch {
    return false;
  }
}

interface GitRepo {
  toplevel: string;
  gitDir: string;
  commonDir: string;
}

async function findRepo(root: string): Promise<GitRepo | null> {
  const [toplevelOut, gitDirOut, commonDirOut] = (
    await runGit(root, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ])
  )
    .trim()
    .split("\n");
  if (!toplevelOut || !gitDirOut || !commonDirOut) return null;
  const [toplevel, gitDir, commonDir, home] = await Promise.all([
    realpath(toplevelOut),
    realpath(gitDirOut),
    realpath(commonDirOut),
    realpath(homedir()),
  ]);
  // Outside a worktree `git diff` compares any two paths (implicit --no-index), and a
  // `core.worktree` elsewhere would read files outside the folder.
  if (!isInsideOrEqual(root, toplevel) || isBroadFolder(toplevel, home)) return null;
  return { toplevel, gitDir, commonDir };
}

function isUnsafeRepoConfig({ key, value }: GitConfigEntry): boolean {
  if (key === "core.fsmonitor" && FALSE_CONFIG_VALUE.test(value)) return false;
  return UNSAFE_REPO_CONFIG.some((pattern) => pattern.test(key));
}

/**
 * A `.git` entry inside the folder can be planted. A `.git` folder must keep its common directory
 * inside the folder; a `.git` file must point at a git directory that points back (a linked
 * worktree's `gitdir` file, or a submodule's `core.worktree`).
 */
async function repoLayoutIsSafe(
  { toplevel, gitDir, commonDir }: GitRepo,
  root: string,
  localConfig: readonly GitConfigEntry[],
): Promise<boolean> {
  if (isInsideOrEqual(toplevel, root)) {
    if (isInsideOrEqual(gitDir, root)) {
      if (!isInsideOrEqual(commonDir, root)) return false;
    } else if (!(await gitDirPointsBack(gitDir, toplevel, localConfig))) {
      return false;
    }
  }
  return !(
    isInsideOrEqual(commonDir, root) &&
    (await exists(path.join(commonDir, "objects", "info", "alternates")))
  );
}

async function hasReadTriggeredHook(
  { toplevel, commonDir }: GitRepo,
  root: string,
  config: readonly GitConfigEntry[],
): Promise<boolean> {
  const hooksPath = config.findLast((entry) => entry.key === "core.hookspath")?.value;
  const hooksDir = hooksPath ? path.resolve(toplevel, hooksPath) : path.join(commonDir, "hooks");
  const realHooksDir = await realpath(hooksDir).catch(() => null);
  if (realHooksDir === null || !isInsideOrEqual(realHooksDir, root)) return false;
  for (const hook of READ_TRIGGERED_HOOKS) {
    if (await exists(path.join(realHooksDir, hook))) return true;
  }
  return false;
}

/** `git status` and `git diff` run git inside each checked-out submodule, with its own config. */
async function hasCheckedOutSubmodule({ toplevel }: GitRepo, root: string): Promise<boolean> {
  const index = await runGit(root, ["ls-files", "--stage", "-z"]);
  for (const entry of index.split("\0")) {
    if (!entry.startsWith("160000 ")) continue;
    const submodule = path.join(toplevel, entry.slice(entry.indexOf("\t") + 1));
    if (isInsideOrEqual(submodule, root) && (await exists(path.join(submodule, ".git")))) {
      return true;
    }
  }
  return false;
}

async function gitDirPointsBack(
  gitDir: string,
  toplevel: string,
  localConfig: readonly GitConfigEntry[],
): Promise<boolean> {
  const dotGit = await realpath(path.join(toplevel, ".git"));
  const backlink = await readFile(path.join(gitDir, "gitdir"), "utf8").catch(() => null);
  if (backlink !== null) {
    const target = await realpath(path.resolve(gitDir, backlink.trim())).catch(() => null);
    return target === dotGit;
  }
  const worktree = localConfig.findLast((entry) => entry.key === "core.worktree")?.value;
  if (worktree === undefined) return false;
  const target = await realpath(path.resolve(gitDir, worktree)).catch(() => null);
  return target === toplevel;
}

interface GitConfigEntry {
  scope: string;
  key: string;
  value: string;
}

/** Parses `git config --list --show-scope -z`: `scope NUL key LF value NUL` per entry. */
function parseGitConfigList(output: string): GitConfigEntry[] {
  const fields = output.split("\0");
  const entries: GitConfigEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const pair = fields[index + 1];
    const newline = pair.indexOf("\n");
    entries.push({
      scope: fields[index],
      key: (newline < 0 ? pair : pair.slice(0, newline)).toLowerCase(),
      value: newline < 0 ? "" : pair.slice(newline + 1),
    });
  }
  return entries;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10_000,
  });
  return stdout;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Credential file and folder names, matched against every segment of a path as written (split at
 * `/`, `:` and `=`, so `HEAD:.env` and `--x=.env` match) and as resolved inside the folder.
 */
const SECRET_NAMES: readonly RegExp[] = [
  /^\.env(?:\..*)?$/,
  /\.env$/,
  /^\.(?:envrc|npmrc|yarnrc|yarnrc\.yml|netrc|pypirc|pgpass|git-credentials|htpasswd)$/,
  /^_netrc$/,
  /^\.?credentials\.json$/,
  /^\.credentials$/,
  /\.tfstate(?:\.backup)?$/,
  /\.tfvars$/,
  /^id_(?:rsa|ecdsa|ed25519|dsa)/,
  /\.(?:pem|key|p12|pfx|token)$/,
  /^agent\.db/,
  /^auth\.json$/,
  // Folders that hold nothing else: SSH, cloud and cluster credentials, GPG, Docker auth, Paseo's
  // daemon home, and git internals (`.git/config` holds remote URLs, which can carry a token).
  /^\.(?:ssh|aws|kube|gnupg|docker|paseo|secrets|git)$/,
  /^\.paseo-/,
];
/** Credential folders named by two segments. */
const SECRET_FOLDER_PAIRS: readonly (readonly [string, string])[] = [
  [".config", "gh"],
  [".config", "gcloud"],
  [".omp", "agent"],
  [".dev", "paseo-home"],
];

function namesSecret(text: string): boolean {
  const segments = text.split(/[/:=,]/);
  return segments.some(
    (segment, index) =>
      SECRET_NAMES.some((pattern) => pattern.test(segment)) ||
      SECRET_FOLDER_PAIRS.some(
        ([first, second]) => segment === first && segments[index + 1] === second,
      ),
  );
}

// A `..` segment, alone or as part of a `rev:path` or option value. Refused instead of resolved:
// `link/..` means the link target's parent to the kernel but the folder to `path.resolve`.
const PARENT_SEGMENT = /(?:^|[/=:,])\.\.(?:$|[/:,])/;

async function pathStaysInFolder(use: PathUse, root: string): Promise<boolean> {
  const { word } = use;
  if (word === "/dev/null" || word === "-") return true;
  if (
    word.includes("://") ||
    word.startsWith("~") ||
    word.startsWith("@") ||
    PARENT_SEGMENT.test(word) ||
    namesSecret(word)
  ) {
    return false;
  }
  const resolved = await realpathAllowMissing(path.resolve(root, word));
  if (resolved === null || !isInsideOrEqual(resolved.path, root)) return false;
  if (namesSecret(path.relative(root, resolved.path).split(path.sep).join("/"))) return false;
  if (use.regularFile && resolved.exists) {
    return (await stat(resolved.path)).isFile();
  }
  return true;
}

/**
 * `realpath` that resolves a missing path through its nearest existing parent. Null for a
 * dangling symlink (its target may be created later, anywhere) and for any error but ENOENT.
 */
async function realpathAllowMissing(
  target: string,
): Promise<{ path: string; exists: boolean } | null> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return { path: path.join(real, ...missing.toReversed()), exists: missing.length === 0 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      if (await exists(current)) return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `target` exists, a dangling symlink included. */
async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

function isInsideOrEqual(target: string, folder: string): boolean {
  if (target === folder) return true;
  const prefix = folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`;
  return target.startsWith(prefix);
}

/**
 * True for `/`, the home folder, folders above it, and anything inside a dot-folder under home
 * (`~/.config`, `~/.ssh`, `~/git/x/.dev`): from there, paths inside the folder still reach
 * credentials. Both arguments must be real paths.
 */
export function isBroadFolder(folder: string, home: string): boolean {
  if (folder === path.parse(folder).root) return true;
  if (isInsideOrEqual(home, folder)) return true;
  if (!isInsideOrEqual(folder, home)) return false;
  return path
    .relative(home, folder)
    .split(path.sep)
    .some((segment) => segment.startsWith("."));
}

/** The real path of the agent's folder, or null when nothing should auto-approve in it. */
async function agentFolderRoot(folder: string): Promise<string | null> {
  try {
    const [root, home] = await Promise.all([realpath(folder), realpath(homedir())]);
    return isBroadFolder(root, home) ? null : root;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shell line parser
// ---------------------------------------------------------------------------

interface ShellWord {
  text: string;
  /** Holds an unquoted `*`, `?` or `[`, so the shell may replace it with file names. */
  globbed: boolean;
}

interface ShellSegment {
  words: ShellWord[];
  /** The command reads the previous command's output (`a | b`). */
  afterPipe: boolean;
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
  /** Files read with `<`. */
  readonly inputTargets: string[] = [];
  private readonly segments: ShellSegment[] = [];
  private words: ShellWord[] = [];
  private afterPipe = false;
  private word = "";
  private inWord = false;
  private quoted = false;
  private globbed = false;
  private index = 0;

  constructor(private readonly line: string) {}

  parse(): ShellSegment[] | null {
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
    const doubled = char !== ";" && next === char;
    this.afterPipe = char === "|" && !doubled;
    this.index += doubled ? 2 : 1;
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
      const target = this.readTarget();
      if (target === null) return false;
      this.inputTargets.push(target);
      return true;
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
    this.segments.push({ words: this.words, afterPipe: this.afterPipe });
    this.words = [];
    return true;
  }
}
