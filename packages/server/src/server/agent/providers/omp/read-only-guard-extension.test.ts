import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import paseoReadOnlyGuard, {
  isSecretPath,
  OMP_READ_ONLY_GUARD_COMMAND,
  readResultBlockReason,
  searchResultBlockReason,
  toolCallBlockReason,
} from "./read-only-guard-extension.js";

const root = mkdtempSync(path.join(tmpdir(), "paseo-omp-guard-"));
const folder = path.join(root, "agent");
mkdirSync(path.join(folder, "src", "deep"), { recursive: true });
writeFileSync(path.join(folder, "README.md"), "hi\n");
mkdirSync(path.join(root, "outside"));
writeFileSync(path.join(root, "outside", "secret.txt"), "TOKEN=x\n");
symlinkSync(path.join(root, "outside"), path.join(folder, "escape"));
symlinkSync(path.join(root, "outside", "secret.txt"), path.join(folder, "src", "deep", "link"));
symlinkSync(folder, path.join(folder, "src", "self"));
// Secret files inside the folder, and an innocent name that leads to one.
for (const name of [
  ".env",
  ".env.local",
  "server.pem",
  "deploy.key",
  "id_rsa",
  "id_rsa.pub",
  "api-token.txt",
  "client_secret.json",
  "credentials.json",
  ".netrc",
  ".npmrc",
  ".git-credentials",
]) {
  writeFileSync(path.join(folder, name), "X=1\n");
}
mkdirSync(path.join(folder, ".config", "gh"), { recursive: true });
writeFileSync(path.join(folder, ".config", "gh", "hosts.yml"), "oauth_token: x\n");
writeFileSync(path.join(folder, ".config", "gh", "config.yml"), "editor: vim\n");
symlinkSync(path.join(folder, ".env"), path.join(folder, "notes.txt"));
mkdirSync(path.join(folder, "token-store"));
// A skill that lives outside the folder, and one inside whose file leads out.
const skillHome = path.join(root, "skills", "demo");
mkdirSync(skillHome, { recursive: true });
writeFileSync(path.join(skillHome, "SKILL.md"), "# demo\n");
writeFileSync(path.join(root, "outside", "notes.md"), "private\n");
mkdirSync(path.join(folder, ".skills", "evil"), { recursive: true });
symlinkSync(
  path.join(root, "outside", "notes.md"),
  path.join(folder, ".skills", "evil", "SKILL.md"),
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const outside = path.join(root, "outside");

describe("read-only guard extension", () => {
  test.each([
    ["read", { path: "README.md" }],
    ["read", { path: "README.md:1-1" }],
    ["read", { path: "src" }],
    ["read", { path: "src/self/README.md" }],
    ["read", { path: "not-yet-there.txt" }],
    ["grep", { pattern: "TOKEN", path: "src" }],
    ["grep", { pattern: "TOKEN", paths: ["src", "README.md"] }],
    ["grep", { pattern: "TOKEN" }],
    ["glob", { pattern: "**/*.ts", path: "src/**/*.ts" }],
    ["find", { pattern: "*.md" }],
    ["ast_grep", { pat: "x", paths: ["src"] }],
    ["bash", { command: "ls" }],
    ["bash", { command: "ls", cwd: "src/self" }],
    ["todo", { op: "view" }],
    ["read", { path: "skill://demo" }],
    ["read", { path: "skill://demo/SKILL.md" }],
    ["read", { path: "skill://demo/references/api-notes.md:1-40" }],
    ["read", { path: "skill://demo/SKILL.md:raw" }],
    ["read", { path: "skill://plugin/demo/" }],
    ["read", { path: "id_rsa.pub" }],
    ["read", { path: ".config/gh/config.yml" }],
    ["grep", { pattern: "x", path: ".config" }],
    ["grep", { pattern: "x", path: "src;README.md" }],
    ["grep", { pattern: "x", path: ".;!**/.env;!**/*token*;!**/hosts.yml" }],
    ["bash", { command: "ls", cwd: "token-store" }],
  ])("allows %s %j inside the folder", async (tool, input) => {
    await expect(toolCallBlockReason(tool, input, folder)).resolves.toBeUndefined();
  });

  test.each([
    ["absolute path outside", "read", { path: path.join(outside, "secret.txt") }],
    ["absolute path inside", "read", { path: path.join(folder, "README.md") }],
    ["home", "read", { path: "~/.config/gh/hosts.yml" }],
    ["@ shorthand", "read", { path: "@/etc/passwd" }],
    [":/ shorthand", "read", { path: ":/etc/passwd" }],
    ["parent folder", "read", { path: "../outside/secret.txt" }],
    ["symlink to a file outside", "read", { path: "src/deep/link" }],
    ["symlink to a folder outside", "read", { path: "escape/secret.txt" }],
    ["URL", "read", { path: "http://127.0.0.1:1/?leak=x" }],
    ["file URL", "read", { path: "file:///etc/passwd" }],
    ["xd:// device", "read", { path: "xd://ast_edit" }],
    ["agent:// URL", "read", { path: "agent://all" }],
    ["skill traversal", "read", { path: "skill://demo/../../outside/notes.md" }],
    ["skill encoded traversal", "read", { path: "skill://demo/%2e%2e/%2e%2e/notes.md" }],
    ["skill query", "read", { path: "skill://demo?x=1" }],
    ["skill empty segment", "read", { path: "skill://demo//SKILL.md" }],
    ["skill with a quote", "read", { path: 'skill://demo/"x"' }],
    ["skill URL in grep", "grep", { pattern: "x", path: "skill://demo" }],
    ["skill URL in glob", "glob", { pattern: "*", path: "skill://demo/*" }],
    ["uppercase scheme", "read", { path: "SKILL://demo" }],
    ["selector on a symlink", "read", { path: "src/deep/link:1-5" }],
    ["quoted path", "read", { path: '"README.md"' }],
    ["search outside", "grep", { pattern: "TOKEN", path: outside }],
    ["delimited list", "grep", { pattern: "TOKEN", path: `README.md ${outside}` }],
    ["comma list", "grep", { pattern: "TOKEN", path: "README.md,escape" }],
    ["array entry", "grep", { pattern: "TOKEN", paths: ["src", outside] }],
    ["JSON-encoded array", "grep", { pattern: "TOKEN", path: JSON.stringify(["src", outside]) }],
    ["glob through a symlinked folder", "glob", { pattern: "*", path: "escape/*" }],
    ["brace alternative", "glob", { pattern: "*", path: "{src,/etc}/*" }],
    ["glob outside", "find", { pattern: "*", path: `${outside}/*` }],
    ["bash cwd outside", "bash", { command: "cat secret.txt", cwd: outside }],
    ["bash cwd through a symlink", "bash", { command: "cat secret.txt", cwd: "escape" }],
    ["non-string path", "read", { path: 42 }],
    ["semicolon list outside", "grep", { pattern: "x", path: "src;/etc" }],
    ["semicolon list with ..", "grep", { pattern: "x", path: "src;../outside" }],
    ["semicolon list with home", "grep", { pattern: "x", path: "src;~/.ssh" }],
    ["exclusion list through a symlink", "grep", { pattern: "x", path: "escape;!**/.env" }],
  ])("blocks %s", async (_label, tool, input) => {
    await expect(toolCallBlockReason(tool, input, folder)).resolves.toContain(
      `Paseo read-only mode reads only inside ${folder}`,
    );
  });

  test.each(["lsp", "debug", "github", "ida"])(
    "blocks %s, which reaches outside the folder without a path",
    async (tool) => {
      await expect(toolCallBlockReason(tool, {}, folder)).resolves.toContain(
        `does not run ${tool}`,
      );
    },
  );

  test("refuses a read that OMP resolved by suffix match to a symlink leading out", async () => {
    // `read deep/link` finds `src/deep/link` anywhere in the folder and reads its target.
    await expect(
      readResultBlockReason({ resolvedPath: path.join(folder, "src", "deep", "link") }, folder),
    ).resolves.toContain("resolved to a file outside it");
    await expect(
      readResultBlockReason(
        { meta: { source: { type: "path", value: path.join(outside, "secret.txt") } } },
        folder,
      ),
    ).resolves.toBeDefined();
    await expect(
      readResultBlockReason(
        { meta: { source: { type: "path", value: path.join(folder, "README.md") } } },
        folder,
      ),
    ).resolves.toBeUndefined();
  });

  test.each([
    [".env"],
    [".env.local"],
    ["server.pem"],
    ["deploy.key"],
    ["id_rsa"],
    ["api-token.txt"],
    ["client_secret.json"],
    ["credentials.json"],
    [".netrc"],
    [".npmrc"],
    [".git-credentials"],
    [".config/gh/hosts.yml"],
    ["./.ENV"],
    [".env:1-3"],
    [".env*"],
    ["notes.txt"],
    ["src/../.env"],
  ])("hides the secret file %s from read, grep, glob, find and ast_grep", async (name) => {
    // `src/../.env` also has a `..`, which is refused on its own; the rest reach the secret check.
    for (const [tool, argument] of [
      ["read", "path"],
      ["grep", "path"],
      ["glob", "path"],
      ["find", "path"],
      ["ast_grep", "path"],
    ] as const) {
      const reason = await toolCallBlockReason(tool, { [argument]: name }, folder);
      expect(reason, `${tool} ${name}`).toBeDefined();
      expect(reason).toMatch(/hides secret files|reads only inside/);
    }
    for (const [tool, input] of [
      ["grep", { pattern: "X", paths: ["src", name] }],
      ["grep", { pattern: "X", path: `README.md ${name}` }],
      ["glob", { path: JSON.stringify(["src", name]) }],
    ] as const) {
      await expect(
        toolCallBlockReason(tool, input, folder),
        `${tool} ${name}`,
      ).resolves.toBeDefined();
    }
  });

  test("names the secret rule, not the folder rule, for a secret inside the folder", async () => {
    await expect(toolCallBlockReason("read", { path: ".env" }, folder)).resolves.toContain(
      "hides secret files",
    );
    await expect(toolCallBlockReason("read", { path: "notes.txt" }, folder)).resolves.toContain(
      "hides secret files",
    );
    await expect(
      toolCallBlockReason("read", { path: "skill://demo/token.md" }, folder),
    ).resolves.toContain("hides secret files");
  });

  test("matches secret names by their last part, case-insensitively", () => {
    for (const file of [
      ".env",
      "a/.env.production",
      "KEY.PEM",
      "a/b.key",
      "id_ed25519",
      "x/Token.txt",
      "my-secrets.yaml",
      "credentials",
      ".NETRC",
      "/home/k/.config/gh/hosts.yml",
    ]) {
      expect(isSecretPath(file), file).toBe(true);
    }
    for (const file of [
      "README.md",
      "id_rsa.pub",
      "keys.ts",
      "environment.ts",
      "hosts.yml",
      "gh/config.yml",
      "secrets/readme.md",
      "src/",
      "",
    ]) {
      expect(isSecretPath(file), file).toBe(false);
    }
  });

  test("drops a search result that lists a secret file, however it names it", async () => {
    const reason = (tool: string, details: unknown) =>
      searchResultBlockReason(tool, details, folder);
    await expect(reason("grep", { files: ["README.md", ".env"], cwd: folder })).resolves.toContain(
      "result included",
    );
    await expect(reason("grep", { files: ["src/a.ts", "deploy.key"] })).resolves.toBeDefined();
    await expect(
      reason("grep", { fileMatches: [{ path: "sub/.env.local", count: 2 }] }),
    ).resolves.toBeDefined();
    await expect(
      reason("ast_grep", { fileMatches: [{ path: "id_rsa", count: 1 }] }),
    ).resolves.toBeDefined();
    await expect(reason("find", { hits: [{ rel: "api-token.txt" }] })).resolves.toBeDefined();
    await expect(reason("glob", { files: [".config/gh/hosts.yml"] })).resolves.toBeDefined();
    // An archive member, and an innocent name that resolves to a secret.
    await expect(reason("grep", { files: ["bundle.zip:conf/.env"] })).resolves.toBeDefined();
    await expect(reason("glob", { files: ["notes.txt"], cwd: folder })).resolves.toBeDefined();
    await expect(
      reason("grep", { files: ["README.md", "src/", ".config/gh/config.yml", "id_rsa.pub"] }),
    ).resolves.toBeUndefined();
    await expect(reason("grep", { matchCount: 0 })).resolves.toBeUndefined();
    await expect(reason("bash", { files: [".env"] })).resolves.toBeUndefined();
  });

  test("refuses a read result that resolved to a secret file", async () => {
    await expect(
      readResultBlockReason({ resolvedPath: path.join(folder, ".env") }, folder),
    ).resolves.toContain("hides secret files");
    await expect(
      readResultBlockReason({ resolvedPath: path.join(folder, "notes.txt") }, folder),
    ).resolves.toContain("hides secret files");
    await expect(
      readResultBlockReason({ resolvedPath: path.join(folder, "id_rsa.pub") }, folder),
    ).resolves.toBeUndefined();
  });

  test("lets a skill read resolve outside the folder, but not a skill file in the folder that leads out", async () => {
    const skillFile = path.join(skillHome, "SKILL.md");
    await expect(
      readResultBlockReason({ resolvedPath: skillFile }, folder, "skill://demo"),
    ).resolves.toBeUndefined();
    // The same result for a plain read is refused: outside the folder.
    await expect(
      readResultBlockReason({ resolvedPath: skillFile }, folder, "README.md"),
    ).resolves.toContain("outside it");
    // Project skill whose SKILL.md is a symlink to a file outside the folder.
    await expect(
      readResultBlockReason(
        { resolvedPath: path.join(folder, ".skills", "evil", "SKILL.md") },
        folder,
        "skill://evil",
      ),
    ).resolves.toContain("outside it");
    // A skill file with a secret name.
    await expect(
      readResultBlockReason(
        { resolvedPath: path.join(skillHome, ".env") },
        folder,
        "skill://demo/.env",
      ),
    ).resolves.toContain("hides secret files");
  });

  test("blocks before OMP runs the tool, replaces outside read results, and registers its command", async () => {
    const commands: string[] = [];
    const handlers = new Map<string, (event: never, ctx: { cwd: string }) => Promise<unknown>>();
    paseoReadOnlyGuard({
      registerCommand: (name) => commands.push(name),
      on: (event: string, handler: (event: never, ctx: { cwd: string }) => Promise<unknown>) => {
        handlers.set(event, handler);
      },
    } as Parameters<typeof paseoReadOnlyGuard>[0]);
    const run = (event: string, payload: unknown) =>
      handlers.get(event)?.(payload as never, { cwd: folder });

    expect(commands).toEqual([OMP_READ_ONLY_GUARD_COMMAND]);
    await expect(
      run("tool_call", { toolName: "read", input: { path: "../outside/secret.txt" } }),
    ).resolves.toMatchObject({ block: true });
    await expect(
      run("tool_call", { toolName: "read", input: { path: "README.md" } }),
    ).resolves.toBeUndefined();
    await expect(
      run("tool_result", {
        toolName: "read",
        details: { resolvedPath: path.join(folder, "src", "deep", "link") },
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      run("tool_result", { toolName: "grep", details: { resolvedPath: outside } }),
    ).resolves.toBeUndefined();
    await expect(
      run("tool_result", {
        toolName: "grep",
        input: { pattern: "X" },
        details: { files: ["README.md", ".env"], cwd: folder },
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      run("tool_result", {
        toolName: "read",
        input: { path: "skill://demo" },
        details: { resolvedPath: path.join(skillHome, "SKILL.md") },
      }),
    ).resolves.toBeUndefined();
  });
});
