import { describe, expect, it } from "vitest";
import type { CodeRunScope } from "./scope";
import {
  matchCodeRunHost,
  parseFenceInfo,
  resolveCodeRunTarget,
  resolveRunFolder,
  type RunWorkspace,
} from "./target";

describe("parseFenceInfo", () => {
  it("reads host and cwd after the language", () => {
    expect(parseFenceInfo("bash", "host=mac cwd=~/src")).toEqual({
      language: "bash",
      request: { host: "mac", cwd: "~/src" },
    });
  });

  it("reads quoted values with spaces", () => {
    expect(parseFenceInfo("sh", `host="MacBook Pro" cwd='/tmp/my dir'`).request).toEqual({
      host: "MacBook Pro",
      cwd: "/tmp/my dir",
    });
  });

  it("keeps an untagged fence untagged", () => {
    expect(parseFenceInfo("bash", null)).toEqual({
      language: "bash",
      request: { host: null, cwd: null },
    });
    expect(parseFenceInfo("", undefined)).toEqual({
      language: null,
      request: { host: null, cwd: null },
    });
  });

  it("finds options when the fence has no language", () => {
    expect(parseFenceInfo("host=mac", null)).toEqual({
      language: null,
      request: { host: "mac", cwd: null },
    });
  });

  it("ignores junk, unknown keys and empty values", () => {
    expect(parseFenceInfo("bash", "title=x host= {.lineNumbers} hostname cwd")).toEqual({
      language: "bash",
      request: { host: null, cwd: null },
    });
  });
});

describe("matchCodeRunHost", () => {
  const hosts = [
    { serverId: "srv_omen", label: "omen" },
    { serverId: "srv_mac", label: "MacBook Pro" },
  ];

  it("matches a label with case and spaces ignored", () => {
    expect(matchCodeRunHost("macbookpro", hosts)?.serverId).toBe("srv_mac");
    expect(matchCodeRunHost("MACBOOK pro", hosts)?.serverId).toBe("srv_mac");
    expect(matchCodeRunHost("Omen", hosts)?.serverId).toBe("srv_omen");
  });

  it("matches a serverId", () => {
    expect(matchCodeRunHost("srv_mac", hosts)?.label).toBe("MacBook Pro");
  });

  it("knows no aliases", () => {
    expect(matchCodeRunHost("mac", hosts)).toBeNull();
    expect(matchCodeRunHost("", hosts)).toBeNull();
  });
});

describe("resolveRunFolder", () => {
  it("defaults to the host's home and expands ~", () => {
    expect(resolveRunFolder(null, "/Users/k/")).toBe("/Users/k");
    expect(resolveRunFolder("~/src/app/", "/Users/k")).toBe("/Users/k/src/app");
    expect(resolveRunFolder("src", "/Users/k")).toBe("/Users/k/src");
  });

  it("keeps absolute paths and needs a home for the rest", () => {
    expect(resolveRunFolder("/opt/x", null)).toBe("/opt/x");
    expect(resolveRunFolder(null, null)).toBeNull();
  });
});

describe("resolveCodeRunTarget", () => {
  const chat: CodeRunScope = {
    serverId: "srv_omen",
    agentId: "agent-1",
    workspaceId: "ws-omen",
    cwd: "/home/k/git/paseo",
    messageKey: "msg-1",
    openTerminal: () => undefined,
  };
  const mac = { serverId: "srv_mac", label: "MacBook Pro" };
  const macWorkspaces: RunWorkspace[] = [
    { id: "ws-home", workspaceDirectory: "/Users/k", archivingAt: null },
    { id: "ws-app", workspaceDirectory: "/Users/k/src/app", archivingAt: null },
    { id: "ws-gone", workspaceDirectory: "/Users/k/src/app/sub", archivingAt: "2026-11-17" },
  ];
  const macState = {
    host: mac,
    connected: true,
    homeDirectory: "/Users/k",
    workspaces: macWorkspaces,
  };

  it("runs an untagged fence where the chat runs", () => {
    const target = resolveCodeRunTarget(chat, { host: null, cwd: null }, macState);
    expect(target).toEqual({
      kind: "ready",
      place: { serverId: "srv_omen", cwd: "/home/k/git/paseo", workspaceId: "ws-omen" },
    });
  });

  it("runs a tagged fence on the named host, in its home by default", () => {
    const target = resolveCodeRunTarget(chat, { host: "macbookpro", cwd: null }, macState);
    expect(target).toEqual({
      kind: "ready",
      place: { serverId: "srv_mac", cwd: "/Users/k", workspaceId: "ws-home" },
    });
  });

  it("puts the terminal in the deepest live workspace that holds cwd", () => {
    const target = resolveCodeRunTarget(chat, { host: "srv_mac", cwd: "~/src/app/sub" }, macState);
    expect(target).toEqual({
      kind: "ready",
      place: { serverId: "srv_mac", cwd: "/Users/k/src/app/sub", workspaceId: "ws-app" },
    });
  });

  it("never falls back to the chat's host", () => {
    expect(
      resolveCodeRunTarget(chat, { host: "nas", cwd: null }, { ...macState, host: null }),
    ).toEqual({ kind: "unknownHost", name: "nas" });
    expect(
      resolveCodeRunTarget(
        chat,
        { host: "macbookpro", cwd: null },
        { ...macState, connected: false },
      ),
    ).toEqual({ kind: "offline", serverId: "srv_mac", hostLabel: "MacBook Pro" });
    expect(
      resolveCodeRunTarget(
        chat,
        { host: "macbookpro", cwd: null },
        { ...macState, homeDirectory: null },
      ),
    ).toEqual({ kind: "noHome", serverId: "srv_mac", hostLabel: "MacBook Pro" });
  });

  it("asks for a new hidden workspace only when no open one holds the folder", () => {
    const request = { host: "macbookpro", cwd: "/opt/tools" };
    expect(resolveCodeRunTarget(chat, request, macState)).toEqual({
      kind: "ready",
      place: { serverId: "srv_mac", cwd: "/opt/tools", workspaceId: null },
    });
    // The hidden workspace an earlier run opened is in the host's list and gets reused.
    const reopened = {
      ...macState,
      workspaces: [
        ...macWorkspaces,
        { id: "ws-hidden", workspaceDirectory: "/opt/tools", archivingAt: null },
      ],
    };
    expect(resolveCodeRunTarget(chat, request, reopened)).toEqual({
      kind: "ready",
      place: { serverId: "srv_mac", cwd: "/opt/tools", workspaceId: "ws-hidden" },
    });
  });
});
