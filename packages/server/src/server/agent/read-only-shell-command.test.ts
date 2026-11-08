import { describe, expect, test } from "vitest";

import { isReadOnlyShellCommand } from "./read-only-shell-command.js";

describe("isReadOnlyShellCommand", () => {
  test.each([
    "ls -la",
    "cat package.json",
    "cat ./README.md",
    "git status --short",
    "git log --oneline -20",
    "git log main..HEAD",
    "git -C packages/server --no-pager diff main...HEAD -- src",
    "git show HEAD~1:README.md",
    "git branch -a",
    "git branch --show-current",
    "git branch -vv --sort=-committerdate",
    "git tag --list 'v1.*'",
    "git remote",
    "git config --get user.name",
    "git stash list",
    "git worktree list",
    "git grep -n TODO",
    "rg -n 'foo|bar' packages/server",
    'grep -n "a;b" src/index.ts | head -20',
    "find . -name '*.ts' -not -path './node_modules/*'",
    "wc -l < package.json",
    "ls missing 2>/dev/null || echo none",
    "git log -1 2>&1 | cat",
    "diff a.txt /dev/null",
    "sort package.json | uniq -c",
    "echo '$HOME'",
    "jq '.scripts' package.json",
    "jq -r '.name' package.json",
    "ps aux",
    "printf '%s\\n' a",
  ])("reads only: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(true);
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
    "uniq in.txt out.txt",
    "uniq -- in -out",
    "tree -o out.txt",
    "find . -name '*.tmp' -delete",
    "find . -exec rm x \\;",
    "find . -fprint out.txt",
    "rg --pre ./run.sh foo",
    "fd -x rm",
    "date -s 2020-01-01",
    // Mutating git.
    "git push",
    "git commit -m wip",
    "git checkout main",
    "git branch new-branch",
    "git branch -D old",
    "git tag v1.0",
    "git remote add origin url",
    "git config user.name me",
    "git config --unset --get user.name",
    "git stash",
    "git worktree add ../x",
    "git -c core.pager=sh log",
    "git branch --list",
    "git branch -u origin/main",
    "git log --output=out.txt",
    "git diff --ext-diff",
    "git grep -O foo",
    "git",
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
  ])("asks: %j", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });

  test.each([
    // Paseo daemon home.
    "cat ~/.paseo/daemon.log",
    "cat /home/k/.paseo/config.json",
    "ls .paseo",
    "cd ~/.paseo && cat config.json",
    // .env files.
    "cat .env",
    "cat apps/web/.env.local",
    "grep KEY .env.production",
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
    // A glob in a hidden segment can reach any of them.
    "cat ~/.ss?/id_*",
    "cat ~/.p*/config.json",
  ])("asks for a secret path: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
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
  ])("asks when expansion could change the arguments: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });

  // Bypasses from the security review of the first version.
  test.each([
    // A redirect target glued to a quote is one word to the shell: `>&1'x'` writes `1x`.
    "echo hi >&1'x'",
    "cat <.en'v'",
    "echo hi >/dev/null'x'",
    'cat <README.md"x"',
    "cat <README.md\\x",
  ])("asks for a redirect target glued to more text: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });

  test.each([
    "sort --outp=x in.txt",
    "sort --compress-prog=sh in.txt",
    "file --comp magic",
    "git grep --open=vim foo",
    "git log --outp=x",
    "git branch --set-upstream-t=origin/main",
    "jq --in-pl . a.json",
    "rg --no-ignore-vcs token",
  ])("asks for an abbreviated or family long option: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
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
    "grep -f/etc/patterns file.txt",
    "git --git-dir=/srv/repo.git log",
    "git -C .. log",
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
    // Recursive reads open `.env` files inside the folder.
    "grep -r token .",
    "grep -R token",
    "grep -d recurse token .",
    "egrep --recursive token .",
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
  ])("asks for a path that may leave the agent's folder: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
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
  ])("asks for writes, network calls and token reads: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
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
  ])("asks for commands that print the environment: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });
});
