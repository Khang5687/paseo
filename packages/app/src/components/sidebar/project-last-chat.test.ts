import { describe, expect, it } from "vitest";
import { findProjectForWorkspace, resolveProjectLastChat } from "./project-last-chat";

const alpha = {
  viewKey: "alpha",
  workspaces: [
    { serverId: "s1", workspaceId: "a1" },
    { serverId: "s1", workspaceId: "a2" },
  ],
};
const beta = { viewKey: "beta", workspaces: [{ serverId: "s2", workspaceId: "a1" }] };

describe("findProjectForWorkspace", () => {
  it("matches on server and workspace together", () => {
    expect(findProjectForWorkspace([alpha, beta], { serverId: "s2", workspaceId: "a1" })).toBe(
      "beta",
    );
  });

  it("returns null for a workspace no loaded project lists", () => {
    expect(findProjectForWorkspace([alpha, beta], { serverId: "s3", workspaceId: "a1" })).toBe(
      null,
    );
  });
});

describe("resolveProjectLastChat", () => {
  it("returns the remembered workspace while the project lists it", () => {
    expect(resolveProjectLastChat(alpha, { serverId: "s1", workspaceId: "a2" })).toEqual({
      serverId: "s1",
      workspaceId: "a2",
    });
  });

  it("drops a remembered workspace the project no longer lists", () => {
    expect(resolveProjectLastChat(alpha, { serverId: "s1", workspaceId: "gone" })).toBe(null);
  });

  it("returns null when nothing was remembered", () => {
    expect(resolveProjectLastChat(beta, undefined)).toBe(null);
  });
});
