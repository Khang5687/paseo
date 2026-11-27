import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createHostClient } from "@getpaseo/client/node";
import type { DaemonClient } from "@getpaseo/client";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function daemon(
  options: Parameters<typeof createTestPaseoDaemon>[0] = {},
): Promise<TestPaseoDaemon> {
  const instance = await createTestPaseoDaemon(options);
  cleanup.push(() => instance.close());
  return instance;
}

async function connect(instance: TestPaseoDaemon): Promise<DaemonClient> {
  const client = createHostClient(`127.0.0.1:${instance.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await client.connect();
  cleanup.push(() => client.close());
  return client;
}

async function turn(client: DaemonClient, agentId: string, text: string): Promise<void> {
  await client.sendMessage(agentId, text);
  await client.waitForFinish(agentId, 15000);
}

test(
  "a mentioned file is copied to the target host and stays readable there while its host is down",
  { timeout: 60000 },
  async () => {
    const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-file-copies-")));
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    await mkdir(path.join(workspace, "notes"));
    const planPath = path.join(workspace, "notes", "plan.md");
    await writeFile(planPath, "# Plan\n\nShip the copies.\n");

    const b = await daemon();
    const a = await daemon({ agentClients: createTestAgentClients() });
    const aClient = await connect(a);
    const bClient = await connect(b);
    const bServerId = b.daemon.getServerId();
    const aServerId = a.daemon.getServerId();

    expect(bClient.getLastServerInfoMessage()?.features?.fileCopies).toBe(true);
    await aClient.addHost({ connection: `127.0.0.1:${b.port}` });
    await expect
      .poll(async () => (await aClient.listHosts()).hosts[0]?.status, { timeout: 15000 })
      .toBe("online");
    const { settings } = await aClient.updateFileCopySettings({ targetServerId: bServerId });
    expect(settings).toMatchObject({
      targetServerId: bServerId,
      keepDays: 30,
      maxTotalBytes: 5 * 1024 ** 3,
      maxFileBytes: 64 * 1024 ** 2,
    });

    const agent = await aClient.createAgent({
      provider: "claude",
      cwd: workspace,
      title: "File copies",
      modeId: "bypassPermissions",
    });
    await turn(
      aClient,
      agent.id,
      "respond with exactly: Wrote `notes/plan.md`; `missing.md` does not exist.",
    );

    let copies = await bClient.listFileCopies();
    await expect
      .poll(
        async () => {
          copies = await bClient.listFileCopies();
          return copies.entries.map((entry) => entry.path);
        },
        { timeout: 15000 },
      )
      .toEqual([planPath]);
    const first = copies.entries[0]!;
    expect(first.sourceServerId).toBe(aServerId);

    // An unchanged file is not sent again; the mention only keeps the copy alive.
    await turn(aClient, agent.id, "respond with exactly: Still see `notes/plan.md`.");
    await expect
      .poll(async () => (await bClient.listFileCopies()).entries[0]?.lastMentionedAt, {
        timeout: 15000,
      })
      .not.toBe(first.lastMentionedAt);
    expect((await bClient.listFileCopies()).entries[0]?.savedAt).toBe(first.savedAt);

    await a.close();

    const copy = await bClient.readFileCopy({ sourceServerId: aServerId, path: planPath });
    expect(new TextDecoder().decode(copy.bytes)).toBe("# Plan\n\nShip the copies.\n");
    expect(copy).toMatchObject({ kind: "text", path: planPath, revision: first.revision });
    expect(copy.entry.savedAt).toBe(first.savedAt);
    await expect(
      bClient.readFileCopy({ sourceServerId: aServerId, path: path.join(workspace, "missing.md") }),
    ).rejects.toThrow(/No copy/);
  },
);
