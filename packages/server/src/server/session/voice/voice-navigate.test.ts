import { describe, expect, test } from "vitest";
import type { VoiceChat, VoiceChatProject } from "@getpaseo/protocol/voice/chat-directory";
import { resolveGoToTarget } from "@getpaseo/protocol/voice/chat-match";
import {
  buildArrivedSpeech,
  buildChatListSpeech,
  parseVoiceNavCommand,
  resolveChatPick,
} from "./voice-navigate.js";

function chat(agentId: string, title: string | null, lastActiveAt = 0): VoiceChat {
  return { agentId, workspaceId: `ws-${agentId}`, title, lastActiveAt };
}

function project(projectId: string, name: string, chats: VoiceChat[]): VoiceChatProject {
  return { projectId, name, chats };
}

const fitupMain = chat("fitup-main", "Main chat", 3);
const fitupScan = chat("fitup-scan", "Food scan redesign 🍎", 2);
const paseoHandsFree = chat("paseo-hf", "Paseo hands-free: voice words and navigation", 5);
const paseoRelease = chat("paseo-release", "Release beta 0.19", 4);
const paseoSync = chat("paseo-sync-chat", "Upstream sync", 1);

const directory: VoiceChatProject[] = [
  project("fitup", "fitup", [fitupMain, fitupScan]),
  project("paseo", "paseo", [paseoHandsFree, paseoRelease]),
  project("paseo-sync", "paseo-sync", [paseoSync]),
  project("bible", "bible-scroll-app", []),
];

function goTo(spoken: string, currentProjectId: string | null = null) {
  const command = parseVoiceNavCommand(spoken);
  if (command?.kind !== "go_to") return null;
  const target = resolveGoToTarget(command.target, directory, currentProjectId);
  return target ? { project: target.project.projectId, chat: target.chat?.agentId ?? null } : null;
}

describe("parseVoiceNavCommand", () => {
  test("reads the commands as whole utterances, whatever the case and punctuation", () => {
    expect(parseVoiceNavCommand("Go to FitUp.")).toEqual({ kind: "go_to", target: "fitup" });
    expect(parseVoiceNavCommand("Okay, switch to the paseo release chat, over.")).toEqual({
      kind: "go_to",
      target: "paseo release chat",
    });
    expect(parseVoiceNavCommand("Go back.")).toEqual({ kind: "go_back" });
    expect(parseVoiceNavCommand("Which chats?")).toEqual({ kind: "list_chats" });
    expect(parseVoiceNavCommand("List the chats.")).toEqual({ kind: "list_chats" });
    expect(parseVoiceNavCommand("What chats are there?")).toEqual({ kind: "list_chats" });
  });

  test("talk that only contains the words is not a command", () => {
    expect(parseVoiceNavCommand("Please go back to the previous version of the file")).toBeNull();
    expect(parseVoiceNavCommand("I want to go to fitup later")).toBeNull();
    expect(parseVoiceNavCommand("con agent này go to fitup đi")).toBeNull();
    expect(parseVoiceNavCommand("Which chats did we archive yesterday and why")).toBeNull();
    expect(
      parseVoiceNavCommand("Go to the settings page and fix the button that overlaps the header"),
    ).toBeNull();
  });
});

describe("resolveGoToTarget", () => {
  test("names a project, or a project and one of its chats in one go", () => {
    expect(goTo("Go to fitup")).toEqual({ project: "fitup", chat: null });
    expect(goTo("Go to fit up, food scan")).toEqual({ project: "fitup", chat: "fitup-scan" });
    expect(goTo("Go to paseo hands free")).toEqual({ project: "paseo", chat: "paseo-hf" });
    expect(goTo("Go to paseo release beta")).toEqual({ project: "paseo", chat: "paseo-release" });
  });

  test("an exact project name wins over a project whose name only starts the same", () => {
    expect(goTo("Go to paseo")).toEqual({ project: "paseo", chat: null });
    expect(goTo("Go to paseo sync")).toEqual({ project: "paseo-sync", chat: null });
  });

  test("a chat of the current project can be named without the project", () => {
    expect(goTo("Go to main chat", "fitup")).toEqual({ project: "fitup", chat: "fitup-main" });
    expect(goTo("Go to main chat", "bible")).toBeNull();
  });

  test("a go-to whose target names nothing is left for the agent", () => {
    expect(goTo("Go to the auth module")).toBeNull();
    expect(goTo("Go to sleep")).toBeNull();
    expect(goTo("Go to paseo and fix the tests")).toBeNull();
  });

  test("an emoji in a title does not stop it matching", () => {
    expect(goTo("Go to fitup food scan redesign")).toEqual({
      project: "fitup",
      chat: "fitup-scan",
    });
  });
});

describe("chat pick", () => {
  test("the reply to 'Which one?' is an ordinal of the names read out, or a name", () => {
    const chats = [fitupMain, fitupScan];
    expect(resolveChatPick("The second one.", chats)).toBe(fitupScan);
    expect(resolveChatPick("Food scan.", chats)).toBe(fitupScan);
    expect(resolveChatPick("The main chat", chats)).toBe(fitupMain);
    expect(resolveChatPick("Number five.", chats)).toBeNull();
    expect(resolveChatPick("Tell me a joke.", chats)).toBeNull();
  });

  test("the list reads five names, the rest as a count, then asks", () => {
    const many = project(
      "big",
      "Paseo",
      ["One", "Two", "Three", "Four", "Five", "Six", "Seven"].map((title, index) =>
        chat(`c${index}`, `${title} 🚀 chat`),
      ),
    );
    expect(buildChatListSpeech(many)).toBe(
      "Paseo has 7 chats: One chat, Two chat, Three chat, Four chat, Five chat, and 2 more. Which one?",
    );
    expect(buildArrivedSpeech({ project: directory[0], chat: fitupMain })).toBe(
      "fitup, Main chat.",
    );
  });
});
