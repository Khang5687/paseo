import { describe, expect, test } from "vitest";

import { isReadOnlyShellCommand } from "./read-only-shell-command.js";

describe("isReadOnlyShellCommand", () => {
  test.each([
    "ls -la",
    "cat package.json",
    "git status --short",
    "git log --oneline -20",
    "git -C ../other --no-pager diff main...HEAD -- src",
    "git show HEAD~1:README.md",
    "git branch -a",
    "git branch --show-current",
    "git tag --list 'v1.*'",
    "git remote -v",
    "git config --get user.name",
    "git stash list",
    "git worktree list",
    "rg -n 'foo|bar' packages/server",
    'grep -rn "a;b" src | head -20',
    "find . -name '*.ts' -not -path './node_modules/*'",
    "cd packages/server && ls",
    "wc -l < package.json",
    "ls missing 2>/dev/null || echo none",
    "git log -1 2>&1 | cat",
    "sort package.json | uniq -c",
    "echo '$HOME'",
    "jq '.scripts' package.json",
    "jq -r '.name' package.json",
    "cat src/*.ts",
    "ls -d .github packages/*",
    "ps aux",
    "ps -ef",
    "printf '%s\\n' a",
    "ls ~/.config/nvim",
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
