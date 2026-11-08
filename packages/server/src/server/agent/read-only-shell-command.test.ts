import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import { isBroadFolder, isReadOnlyShellCommand } from "./read-only-shell-command.js";

const root = mkdtempSync(path.join(tmpdir(), "paseo-read-only-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function write(file: string, content = "x\n"): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A repository with one commit. */
function repo(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const file of ["README.md", "package.json", "src/index.ts", "a.txt", "b.txt", "sub/a"]) {
    write(path.join(dir, file), file === "package.json" ? '{"name":"x"}\n' : `${file}\n`);
  }
  git(dir, "add", ".");
  git(
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "init",
  );
  return dir;
}

const outside = path.join(root, "outside");
write(path.join(outside, "secret.txt"), "TOKEN=outside-secret\n");

// The agent's folder: a repository with untracked secrets and symlinks that point out of it.
const folder = repo("folder");
write(path.join(folder, ".env"), "API_KEY=dotenv-secret\n");
write(path.join(folder, "args"), `${path.join(outside, "secret.txt")}\n`);
symlinkSync("../outside/secret.txt", path.join(folder, "link"));
symlinkSync(path.join(outside, "secret.txt"), path.join(folder, "abs-link"));
symlinkSync("../outside/missing.txt", path.join(folder, "dangling"));
symlinkSync("../outside", path.join(folder, "dirlink"));
symlinkSync(".env", path.join(folder, "innocent"));

// A folder outside any repository, where `git diff a b` compares any two paths.
const plain = path.join(root, "plain");
write(path.join(plain, "sub", "a"), "hi\n");
write(path.join(plain, ".env"), "API_KEY=dotenv-secret\n");

const approves = (command: string, cwd = folder) => isReadOnlyShellCommand(command, cwd);

describe("isReadOnlyShellCommand", () => {
  test.each([
    "ls -la",
    "cat package.json",
    "cat ./README.md",
    `cat ${path.join(folder, "README.md")}`,
    "cat missing/new.txt",
    "head -20 README.md",
    "tail -n +5 README.md",
    "git status --short",
    "git log --oneline -20",
    "git log main..HEAD",
    "git --no-pager diff HEAD -- src",
    "git show HEAD:README.md",
    "git branch -a",
    "git branch --show-current",
    "git branch -vv --sort=-committerdate",
    "git tag --list 'v1.*'",
    "git remote",
    "git config --get user.name",
    "git stash list",
    "git worktree list",
    "git grep -n TODO",
    "git grep -n -e foo -- src",
    "rg -n 'foo|bar' src/index.ts",
    "cat a.txt | rg foo",
    "rg --files src",
    'grep -n "a;b" src/index.ts | head -20',
    "find . -name '*.ts' -not -path './node_modules/*'",
    "find src -type f -newer README.md",
    "fd -e ts . src",
    "wc -l < package.json",
    "ls missing 2>/dev/null || echo none",
    "git log -1 2>&1 | cat",
    "diff a.txt /dev/null",
    "diff a.txt b.txt",
    "sort package.json | uniq -c",
    "echo '$HOME'",
    "jq '.scripts' package.json",
    "jq -r --arg k name '.[$k]' package.json",
    "ps -eo pid,comm",
    "printf '%s\\n' a",
    "du -sh src",
    "tree -L 2 src",
    "stat -c %s README.md",
    "test -f README.md && echo yes",
    "date +%Y",
  ])("reads only: %s", async (command) => {
    expect(await approves(command)).toBe(true);
  });

  test.each([
    // Unknown commands ask.
    "npm test",
    "node script.js",
    "sed -n 1,10p file",
    "awk '{print $1}' file",
    "xargs cat",
    "less file",
    "env",
    "sudo ls",
    // Writes and deletions.
    "rm -rf build",
    "touch file",
    "echo hi > file",
    "echo hi >> file",
    "cat a | tee b",
    "sort -o out.txt in.txt",
    "sort -T tmp in.txt",
    "uniq in.txt out.txt",
    "uniq -- in -out",
    "tree -o out.txt",
    "find . -name '*.tmp' -delete",
    "find . -exec rm x \\;",
    "find . -fprint out.txt",
    "rg --pre ./run.sh foo a.txt",
    "fd -x rm",
    "date -s 2020-01-01",
    "date 0101000020",
    // Mutating git.
    "git push",
    "git commit -m wip",
    "git checkout main",
    "git branch new-branch",
    "git branch -a new-branch",
    "git branch -D old",
    "git tag v1.0",
    "git remote add origin url",
    "git config user.name me",
    "git config --unset --get user.name",
    "git stash",
    "git reflog expire --all",
    "git worktree add ../x",
    "git -c core.pager=sh log",
    "git branch --list",
    "git branch -u origin/main",
    "git log --output=out.txt",
    "git diff --ext-diff",
    "git log --textconv -p",
    "git log --show-signature",
    "git grep -O foo",
    "git",
    // An option the command's list does not hold asks, even a harmless one.
    "cat --version",
    "ls --dereference",
    "echo -x",
    // Shell features that can run or hide commands.
    "ls $(rm -rf x)",
    "ls `rm -rf x`",
    'echo "$(rm -rf x)"',
    "echo ${x:=y}",
    "(rm -rf x)",
    "{ rm -rf x; }",
    "find . {-delete,}",
    "cat <(rm x)",
    "ls & rm x",
    "ls |& cat",
    "ls\nrm x",
    "ls # ; rm x",
    "FOO=bar ls",
    "cat <<EOF",
    "echo 'unterminated",
    "ls &&",
    "| ls",
    "",
    "   ",
  ])("asks: %j", async (command) => {
    expect(await approves(command)).toBe(false);
  });

  test.each([
    // Paseo daemon home.
    "cat ~/.paseo/daemon.log",
    "cat /home/k/.paseo/config.json",
    "ls .paseo",
    "cd ~/.paseo && cat config.json",
    "cat .dev/paseo-home/config.json",
    // .env files, inside the folder too.
    "cat .env",
    "cat apps/web/.env.local",
    "cat config/prod.env",
    "grep KEY .env.production",
    "grep KEY -- .env",
    "rg KEY .env",
    "diff .env a.txt",
    "git log -p -- .env",
    "git show HEAD:.env",
    "git show HEAD:apps/.env.local",
    "cat .envrc",
    // Package manager, netrc and git credentials.
    "cat .npmrc",
    "cat .yarnrc.yml",
    "cat .netrc",
    "cat .pypirc",
    "cat .git-credentials",
    "cat .git/config",
    // Cloud and infrastructure credentials.
    "cat .aws/credentials",
    "cat .kube/config",
    "cat infra/terraform.tfstate",
    "cat infra/terraform.tfstate.backup",
    "jq . credentials.json",
    "cat packages/app/.secrets/eas.json",
    // SSH.
    "cat ~/.ssh/config",
    "ls /home/k/.ssh/",
    "cat id_rsa",
    "cat keys/id_ed25519.pub",
    "wc -c < /home/k/.ssh/id_rsa",
    // OMP credentials.
    "cat ~/.omp/agent/agent.db",
    "strings /home/k/.omp/agent/auth.json",
    "cat ~/.omp/agent/auth-broker.token",
    "ls ~/.omp/agent/*",
    "cd ~/.omp/agent",
    // GitHub CLI.
    "cat ~/.config/gh/hosts.yml",
    // Key files.
    "cat certs/server.pem",
    "cat tls.key",
    // A symlink inside the folder that points at a secret inside it.
    "cat innocent",
    // A glob in a hidden segment can reach any of them.
    "cat ~/.ss?/id_*",
    "cat ~/.p*/config.json",
  ])("asks for a secret path: %s", async (command) => {
    expect(await approves(command)).toBe(false);
  });

  test.each([
    // A variable set earlier in the persistent shell can hold any flag.
    "find . $A",
    "git log $O",
    'sort "$F"',
    "echo $HOME",
    "cat $HOME/.paseo/config.json",
    // A glob can expand to a file named like a flag the argument check would refuse.
    "find *",
    "sort *.txt",
    "uniq *",
    "tree d*",
    "file *",
    "date ?",
    "rg foo *",
    "fd x [a]*",
    "git log -- *",
    "ps a*",
    "jq . *.json",
    "printf *",
  ])("asks when expansion could change the arguments: %s", async (command) => {
    expect(await approves(command)).toBe(false);
  });

  // Inputs from the first security review.
  describe("first review", () => {
    test.each([
      // A redirect target glued to a quote is one word to the shell: `>&1'x'` writes `1x`.
      "echo hi >&1'x'",
      "cat <.en'v'",
      "echo hi >/dev/null'x'",
      'cat <README.md"x"',
      "cat <README.md\\x",
    ])("asks for a redirect target glued to more text: %s", async (command) => {
      expect(await approves(command)).toBe(false);
    });

    test.each([
      "sort --outp=x in.txt",
      "sort --compress-prog=sh in.txt",
      "file --comp magic",
      "git grep --open=vim foo",
      "git log --outp=x",
      "git branch --set-upstream-t=origin/main",
      "jq --in-pl . a.json",
      "rg --no-ignore-vcs token a.txt",
    ])("asks for an abbreviated or family long option: %s", async (command) => {
      expect(await approves(command)).toBe(false);
    });

    test.each([
      // Outside the agent's folder.
      "cat /etc/passwd",
      "cat /proc/self/environ",
      "cat ~/.config/g?/hosts.yml",
      "cat '~/notes.txt'",
      "cat ../secrets.txt",
      "cat docs/../../secrets.txt",
      "cat -- /etc/hosts",
      "grep -f/etc/patterns a.txt",
      "git --git-dir=/srv/repo.git log",
      "git -C .. log",
      "git -C src log",
      "git show HEAD:../x",
      "ls ~/.config/nvim",
      // Stepwise cd.
      "cd ~/.config/gh && cat hosts.yml",
      "cd src && ls",
      "cd ..",
      // Globs.
      "cat src/*.ts",
      "ls .*",
      "cat .??v",
      // Recursive reads open `.env` and other secret files inside the folder.
      "grep -r token .",
      "grep -R token",
      "grep -d recurse token .",
      "grep token src",
      "egrep --recursive token .",
      "rg token",
      "rg token src",
      "rg -n 'foo|bar' src",
      "rg -uuu token",
      "rg --hidden token",
      "rg -. token",
      "rg -L token",
      "rg -z token",
      "diff -r a b",
      "git grep --no-index token",
      "git grep --untracked token",
      // File lists read from a file.
      "wc --files0-from=list.txt",
      "du --files0-from list.txt",
      "find . -files0-from list.txt",
      "md5sum -c sums.txt",
    ])("asks for a path that may leave the agent's folder: %s", async (command) => {
      expect(await approves(command)).toBe(false);
    });

    test.each([
      "jq -i . a.json",
      "jq --in-place . a.json",
      "jq -f prog.jq a.json",
      "jq --from-file prog.jq a.json",
      "jq -rf prog.jq a.json",
      "git ls-remote origin",
      "git ls-remote --upload-pack=sh origin",
      "git remote show origin",
      "git remote -v",
      "git remote get-url origin",
      "git config --list",
      "git config list",
      "git config -l",
      "git config --get remote.origin.url",
      "git config --get http.extraheader",
      "git config --get-regexp .",
      "ps -E",
    ])("asks for writes, network calls and token reads: %s", async (command) => {
      expect(await approves(command)).toBe(false);
    });

    test.each([
      "printenv",
      "printenv HOME",
      "jq -n env",
      "jq -n '$ENV'",
      "jq -n '$ENV.HOME'",
      "ps e",
      "ps auxe",
      "ps eww",
      "ps aux e",
      "printf -v x hi",
    ])("asks for commands that print the environment: %s", async (command) => {
      expect(await approves(command)).toBe(false);
    });
  });

  // Inputs from the second security review.
  describe("second review", () => {
    test.each([
      String.raw`printf '\057tmp\057outside\057secret.txt\0' | sort --files0-fr=-`,
      String.raw`printf '\057home\057k\057.config\057gh\057hosts.yml\0' | sort --files0-f=-`,
      String.raw`printf 'x\0' | wc --files0=-`,
      "sort --files0-from=-",
      "du --files0-from=-",
    ])("asks for a file list read from standard input, in any spelling: %s", async (command) => {
      expect(await approves(command)).toBe(false);
    });

    test.each([
      "git diff --no-index sub .",
      "git diff --no-i sub .",
      "git diff --no-index --stat sub .",
    ])("asks for git diff outside the repository's history: %s", async (command) => {
      expect(await approves(command)).toBe(false);
    });

    test.each(["git diff sub .", "git diff -- sub .", "git status", "git log"])(
      "asks for git in a folder that is not a repository: %s",
      async (command) => {
        expect(await approves(command, plain)).toBe(false);
      },
    );

    test.each([
      "git --git-dir=evil --work-tree=. status",
      "git --git-dir evil status",
      "git --work-tree=. status",
      "git -C evil status",
      "git --exec-path=. status",
      "git -c core.fsmonitor=x status",
    ])("asks for git options that pick another repository or config: %s", async (command) => {
      expect(await approves(command)).toBe(false);
    });

    test.each([
      "cat link",
      "cat abs-link",
      "cat dangling",
      "ls dirlink/",
      "cat dirlink/secret.txt",
      "grep TOKEN link",
      "head -1 < link",
    ])("asks for a symlink inside the folder that leads out of it: %s", async (command) => {
      expect(await approves(command)).toBe(false);
    });

    test.each(["ps", "ps aux", "ps auxww", "ps -ef", "ps -eo pid,args", "ps -o cmd", "ps -eF"])(
      "asks for ps forms that print command lines: %s",
      async (command) => {
        expect(await approves(command)).toBe(false);
      },
    );

    test.each(["diff . sub", "diff sub .", "diff a.txt sub"])(
      "asks for diff of folders: %s",
      async (command) => {
        expect(await approves(command)).toBe(false);
      },
    );

    // OMP's builtins open `scheme://` names as virtual files.
    test.each([
      "cat ssh://host/etc/passwd",
      "cat local://notes.md",
      "sort agent://1",
      "jq . skill://x/SKILL.md",
      "head -1 omp-descriptor://3",
      `jq -n 'import "../../../tmp/outside/data" as $d; $d'`,
      `jq -n 'include "x"; .'`,
      "strings @args",
    ])("asks for names a command opens outside the folder: %s", async (command) => {
      expect(await approves(command)).toBe(false);
    });
  });

  describe("repository config", () => {
    test("approves git in a linked worktree of a repository outside the folder", async () => {
      const main = repo("worktree-main");
      const worktree = path.join(root, "worktree-linked");
      git(main, "worktree", "add", "-q", worktree);
      expect(await approves("git status", worktree)).toBe(true);
      expect(await approves("git log --oneline -3", worktree)).toBe(true);
    });

    test("asks without running the repository's fsmonitor", async () => {
      const marker = path.join(root, "fsmonitor-ran");
      const dir = repo("fsmonitor");
      git(dir, "config", "core.fsmonitor", `touch ${marker}; false`);
      expect(await approves("git status", dir)).toBe(false);
      expect(await approves("git diff", dir)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    });

    test.each([
      ["diff.external", "./run.sh"],
      ["diff.x.textconv", "./run.sh"],
      ["diff.x.command", "./run.sh"],
      ["filter.x.clean", "./run.sh"],
      ["filter.x.process", "./run.sh"],
      ["log.showSignature", "true"],
      ["gpg.program", "./run.sh"],
      ["gpg.ssh.program", "./run.sh"],
      ["core.pager", "./run.sh"],
      ["pager.log", "./run.sh"],
    ])("asks when the repository's own config sets %s", async (key, value) => {
      const dir = repo(`config-${key}`);
      git(dir, "config", key, value);
      expect(await approves("git log -p", dir)).toBe(false);
    });

    test("asks when a hook would run on the index refresh `git status` writes", async () => {
      const dir = repo("hook");
      write(path.join(dir, ".git", "hooks", "post-index-change"), "#!/bin/sh\ntouch x\n");
      expect(await approves("git status", dir)).toBe(false);
    });

    test("asks when core.hooksPath points at such a hook inside the folder", async () => {
      const dir = repo("hooks-path");
      write(path.join(dir, ".husky", "_", "post-index-change"), "#!/bin/sh\n");
      git(dir, "config", "core.hooksPath", ".husky/_");
      expect(await approves("git status", dir)).toBe(false);
    });

    test("asks when the repository borrows objects from another one", async () => {
      const dir = repo("alternates");
      write(
        path.join(dir, ".git", "objects", "info", "alternates"),
        `${path.join(folder, ".git", "objects")}\n`,
      );
      expect(await approves("git log", dir)).toBe(false);
    });

    test("asks for a planted .git file that points at another repository", async () => {
      const dir = path.join(root, "planted-gitfile");
      write(path.join(dir, ".git"), `gitdir: ${path.join(folder, ".git")}\n`);
      expect(await approves("git log", dir)).toBe(false);
    });

    test("asks for a planted .git folder whose common directory lies outside the folder", async () => {
      const dir = path.join(root, "planted-commondir");
      write(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      write(path.join(dir, ".git", "commondir"), `${path.join(folder, ".git")}\n`);
      write(path.join(dir, ".git", "gitdir"), `${path.join(dir, ".git")}\n`);
      expect(await approves("git log", dir)).toBe(false);
    });

    test("asks when a checked-out submodule could hold its own config", async () => {
      const dir = repo("submodule");
      const head = git(folder, "rev-parse", "HEAD").trim();
      git(dir, "update-index", "--add", "--cacheinfo", `160000,${head},mod`);
      mkdirSync(path.join(dir, "mod"));
      git(path.join(dir, "mod"), "init", "-q");
      expect(await approves("git status", dir)).toBe(false);
    });
  });

  describe("agent folder", () => {
    test("asks in a folder that is a symlink to the home folder", async () => {
      const link = path.join(root, "home-link");
      symlinkSync(homedir(), link);
      expect(await approves("ls", link)).toBe(false);
    });

    test.each([
      ["/", true],
      ["/h", true],
      ["/h/.config", true],
      ["/h/.config/gh", true],
      ["/h/git/x/.dev/paseo-home", true],
      ["/h/git/x", false],
      ["/srv/project", false],
    ])("treats %s as broad: %s", (dir, broad) => {
      expect(isBroadFolder(dir, "/h")).toBe(broad);
    });
  });
});
