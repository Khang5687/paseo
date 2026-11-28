import { describe, expect, test } from "vitest";
import type { VoiceChatProject } from "./chat-directory.js";
import { findHostMatches, pickHostMatch, type VoiceHostChats } from "./chat-match.js";

function project(projectId: string, name: string, chats: [string, string][]): VoiceChatProject {
  return {
    projectId,
    name,
    chats: chats.map(([agentId, title], index) => ({
      agentId,
      workspaceId: `ws-${agentId}`,
      title,
      lastActiveAt: chats.length - index,
    })),
  };
}

function host(
  serverId: string,
  hostName: string,
  projects: VoiceChatProject[],
  online = true,
): VoiceHostChats {
  return { serverId, hostName, online, projects };
}

describe("voice go-to across hosts", () => {
  const fitupOnOmen = project("omen-fitup", "FitUp", [["omen-main", "Main chat"]]);
  const fitupOnMac = project("mac-fitup", "FitUp", [
    ["mac-food", "Food scan redesign 🍎"],
    ["mac-gym", "Gym log"],
  ]);
  const paseoOnMac = project("mac-paseo", "Paseo", [["mac-voice", "Hands-free voice"]]);

  test("a chat named only on one host goes there, emoji in its title or not", () => {
    const pick = pickHostMatch(
      findHostMatches("fitup food scan redesign", [
        host("omen", "Omen", [fitupOnOmen]),
        host("mac", "Mac", [fitupOnMac, paseoOnMac]),
      ]),
    );
    expect(pick).toEqual({
      kind: "go",
      match: expect.objectContaining({ serverId: "mac", chatAgentId: "mac-food" }),
    });
  });

  test("the same project name on two online hosts asks which machine", () => {
    const pick = pickHostMatch(
      findHostMatches("fitup", [
        host("omen", "Omen", [fitupOnOmen]),
        host("mac", "Mac", [fitupOnMac]),
      ]),
    );
    expect(pick?.kind).toBe("choose");
    expect(pick?.kind === "choose" && pick.matches.map((match) => match.hostName)).toEqual([
      "Omen",
      "Mac",
    ]);
  });

  test("an online match wins over the same name on an offline host", () => {
    const pick = pickHostMatch(
      findHostMatches("fitup", [
        host("omen", "Omen", [fitupOnOmen]),
        host("mac", "Mac", [fitupOnMac], false),
      ]),
    );
    expect(pick).toEqual({ kind: "go", match: expect.objectContaining({ serverId: "omen" }) });
  });

  test("a name only an offline host has says that host is offline", () => {
    const pick = pickHostMatch(
      findHostMatches("paseo", [
        host("omen", "Omen", [fitupOnOmen]),
        host("mac", "Mac", [paseoOnMac], false),
      ]),
    );
    expect(pick).toEqual({
      kind: "offline",
      match: expect.objectContaining({ serverId: "mac", hostName: "Mac" }),
    });
  });

  test("a name no host has is not a go-to", () => {
    const matches = findHostMatches("the auth module", [
      host("omen", "Omen", [fitupOnOmen]),
      host("mac", "Mac", [fitupOnMac, paseoOnMac]),
    ]);
    expect(matches).toEqual([]);
    expect(pickHostMatch(matches)).toBeNull();
  });
});
