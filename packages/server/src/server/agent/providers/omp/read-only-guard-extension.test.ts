import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import paseoReadOnlyGuard, {
  OMP_READ_ONLY_GUARD_COMMAND,
  readResultBlockReason,
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
    ["internal URL", "read", { path: "skill://agent-home" }],
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
  });
});
