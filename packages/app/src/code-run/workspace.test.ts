import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  resolveRunWorkspace,
  RunWorkspaceError,
  type RunWorkspaceClient,
  type RunWorkspaceRequest,
  type RunWorkspaceResult,
} from "./workspace";

function workspacePayload(id: string, directory: string): WorkspaceDescriptorPayload {
  return {
    id,
    projectId: "project-tools",
    projectDisplayName: "tools",
    projectRootPath: directory,
    workspaceDirectory: directory,
    projectKind: "directory",
    workspaceKind: "directory",
    name: "tools",
    background: true,
    status: "done",
    statusEnteredAt: null,
    activityAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

/** Records every create and answers with `respond`. */
function fakeClient(respond: () => Promise<RunWorkspaceResult>) {
  const calls: RunWorkspaceRequest[] = [];
  const client: RunWorkspaceClient = {
    createWorkspace: (input) => {
      calls.push(input);
      return respond();
    },
  };
  return { client, calls };
}

const NO_STORE = () => undefined;

describe("resolveRunWorkspace", () => {
  it("reuses the workspace that already holds the folder", async () => {
    const { client, calls } = fakeClient(() => Promise.reject(new Error("must not create")));
    const place = { serverId: "srv_mac", cwd: "/Users/k", workspaceId: "ws-home" };
    await expect(resolveRunWorkspace({ client, place, onCreated: NO_STORE })).resolves.toBe(
      "ws-home",
    );
    expect(calls).toEqual([]);
  });

  it("opens one hidden workspace at the folder, even for taps that race", async () => {
    const created = workspacePayload("ws-hidden", "/opt/tools");
    const { client, calls } = fakeClient(() =>
      Promise.resolve({ workspace: created, error: null }),
    );
    const stored: WorkspaceDescriptorPayload[] = [];
    const place = { serverId: "srv_mac", cwd: "/opt/tools", workspaceId: null };
    const runs = [
      resolveRunWorkspace({ client, place, onCreated: (workspace) => stored.push(workspace) }),
      resolveRunWorkspace({ client, place, onCreated: (workspace) => stored.push(workspace) }),
    ];
    await expect(Promise.all(runs)).resolves.toEqual(["ws-hidden", "ws-hidden"]);
    expect(calls).toEqual([
      { source: { kind: "directory", path: "/opt/tools" }, background: true },
    ]);
    expect(stored).toEqual([created]);
  });

  it("reports the host's reason when it cannot open the workspace", async () => {
    const { client } = fakeClient(() =>
      Promise.resolve({ workspace: null, error: "Directory not found: /opt/missing" }),
    );
    const place = { serverId: "srv_mac", cwd: "/opt/missing", workspaceId: null };
    const run = resolveRunWorkspace({ client, place, onCreated: NO_STORE });
    await expect(run).rejects.toBeInstanceOf(RunWorkspaceError);
    await expect(run).rejects.toMatchObject({ reason: "Directory not found: /opt/missing" });
  });

  it("turns a dropped request into the same error, and tries again on the next tap", async () => {
    let attempt = 0;
    const { client, calls } = fakeClient(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("Host does not support background workspaces"))
        : Promise.resolve({ workspace: workspacePayload("ws-2", "/srv"), error: null });
    });
    const place = { serverId: "srv_mac", cwd: "/srv", workspaceId: null };
    await expect(resolveRunWorkspace({ client, place, onCreated: NO_STORE })).rejects.toMatchObject(
      { reason: "Host does not support background workspaces" },
    );
    await expect(resolveRunWorkspace({ client, place, onCreated: NO_STORE })).resolves.toBe("ws-2");
    expect(calls).toHaveLength(2);
  });
});
