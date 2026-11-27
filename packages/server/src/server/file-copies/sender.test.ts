import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCopySender, isSecretPath } from "./sender.js";

describe("isSecretPath", () => {
  const home = "/home/me";

  it.each([
    "/home/me/work/.env.local",
    "/home/me/work/.env",
    "/srv/app/server.pem",
    "/srv/app/tls/server.key",
    "/home/me/work/id_ed25519",
    "/home/me/.ssh/config",
    "/home/me/.paseo/config.json",
  ])("skips %s", (file) => {
    expect(isSecretPath(file, home)).toBe(true);
  });

  it.each([
    "/home/me/work/notes/plan.md",
    "/home/me/work/docs/key-points.md",
    "/home/me/work/environment.md",
    "/home/me/.sshrc-notes.md",
    "/home/other/.ssh-guide.md",
  ])("keeps %s", (file) => {
    expect(isSecretPath(file, home)).toBe(false);
  });
});

describe("FileCopySender.findMentionedFiles", () => {
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), "file-copy-sender-")));
    workspace = path.join(home, "work");
    for (const dir of [".ssh", ".paseo", "work/notes", "work/docs"]) {
      await mkdir(path.join(home, dir), { recursive: true });
    }
    for (const file of [
      ".ssh/config",
      ".paseo/config.json",
      "work/.env.local",
      "work/server.pem",
      "work/notes/plan.md",
      "work/docs/key-points.md",
    ]) {
      await writeFile(path.join(home, file), file);
    }
    await symlink(path.join(home, ".ssh", "config"), path.join(workspace, "notes", "ssh.md"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("drops secrets and links to them before anything is read", async () => {
    const sender = new FileCopySender({
      agentManager: {
        subscribe: () => () => undefined,
        getAgent: () => undefined,
        getLastAssistantMessage: async () => null,
      },
      hosts: { use: async () => undefined as never },
      fileCopies: { readSettings: async () => Promise.reject(new Error("unused")) },
      logger: pino({ level: "silent" }),
      homeDir: home,
    });
    const reply = [
      `Edited \`${path.join(workspace, ".env.local")}\` and \`${path.join(workspace, "server.pem")}\`.`,
      `Also \`~/.ssh/config\`, \`~/.paseo/config.json\` and \`${path.join(workspace, "notes", "ssh.md")}\`.`,
      "The plan is in `notes/plan.md`; see `docs/key-points.md`.",
    ].join("\n");

    const files = await sender.findMentionedFiles(reply, workspace, 1024 * 1024);

    expect(files.map((file) => file.path).sort()).toEqual([
      path.join(workspace, "docs", "key-points.md"),
      path.join(workspace, "notes", "plan.md"),
    ]);
  });
});
