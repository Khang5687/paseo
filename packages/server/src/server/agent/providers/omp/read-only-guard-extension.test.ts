import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import paseoReadOnlyGuard, {
  bashCwdBlockReason,
  OMP_READ_ONLY_GUARD_STATUS_KEY,
  OMP_READ_ONLY_GUARD_STATUS_TEXT,
} from "./read-only-guard-extension.js";

const root = mkdtempSync(path.join(tmpdir(), "paseo-omp-guard-"));
const folder = path.join(root, "agent");
mkdirSync(path.join(folder, "packages", "server"), { recursive: true });
mkdirSync(path.join(root, "outside"));
symlinkSync(path.join(root, "outside"), path.join(folder, "escape"));
symlinkSync(folder, path.join(folder, "packages", "self"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type ToolCallHandler = (
  event: { toolName: string; input?: Record<string, unknown> },
  ctx: { cwd: string; ui: { setStatus: (key: string, text: string | undefined) => void } },
) => Promise<{ block: true; reason: string } | undefined>;

function loadGuard() {
  let handler: ToolCallHandler | undefined;
  paseoReadOnlyGuard({
    on: (_event: "tool_call", registered: ToolCallHandler) => {
      handler = registered;
    },
  });
  const statuses: Array<[string, string | undefined]> = [];
  const call = (toolName: string, input: Record<string, unknown>) =>
    handler?.(
      { toolName, input },
      { cwd: folder, ui: { setStatus: (key, text) => statuses.push([key, text]) } },
    );
  return { call, statuses };
}

describe("read-only guard extension", () => {
  test.each([undefined, "", "packages/self"])(
    "lets bash run in the session folder with cwd %j",
    async (cwd) => {
      await expect(bashCwdBlockReason(cwd, folder)).resolves.toBeUndefined();
    },
  );

  test.each([
    // The review's example: the prompt shows `cat hosts.yml`, the call runs in ~/.config/gh.
    "~/.config/gh",
    // Paseo resolves the paths in a command against the session folder, so a subfolder would
    // make `cat link` name a different file than the one Paseo checked.
    "packages",
    "packages/server/",
    "~",
    "/etc",
    "..",
    "packages/../..",
    // OMP strips these prefixes before resolving, so they can point anywhere.
    "@/etc",
    ":/etc",
    "file:///etc",
    "local://notes",
    // A symlink inside the folder that points out of it.
    "escape",
    "missing",
    ".",
  ])("blocks bash with cwd %j", async (cwd) => {
    await expect(bashCwdBlockReason(cwd, folder)).resolves.toContain("Drop the cwd argument");
  });

  test("blocks a non-string cwd", async () => {
    await expect(bashCwdBlockReason(42, folder)).resolves.toBeDefined();
  });

  test("blocks the call before OMP's approval prompt and reports itself only for calls it allows", async () => {
    const guard = loadGuard();

    await expect(
      guard.call("bash", { command: "cat hosts.yml", cwd: "~/.config/gh" }),
    ).resolves.toEqual({
      block: true,
      reason: expect.stringContaining(folder),
    });
    expect(guard.statuses).toEqual([]);

    await expect(
      guard.call("bash", { command: "cat package.json", cwd: "packages" }),
    ).resolves.toMatchObject({ block: true });

    await expect(guard.call("bash", { command: "cat package.json" })).resolves.toBeUndefined();
    expect(guard.statuses).toEqual([
      [OMP_READ_ONLY_GUARD_STATUS_KEY, OMP_READ_ONLY_GUARD_STATUS_TEXT],
    ]);
  });

  test("leaves other tools alone", async () => {
    const guard = loadGuard();
    await expect(guard.call("read", { path: "/etc/passwd", cwd: "/etc" })).resolves.toBeUndefined();
    expect(guard.statuses).toEqual([]);
  });
});
