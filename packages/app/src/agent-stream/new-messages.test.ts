import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { countNewMessages, markSeenMessages } from "./new-messages";

const at = new Date(0);

function reply(id: string): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: at };
}

function prompt(id: string): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at };
}

describe("countNewMessages", () => {
  it("counts replies committed after the reader scrolled up", () => {
    const tail = [prompt("p1"), reply("r1")];
    const mark = markSeenMessages(tail, []);
    expect(countNewMessages(mark, [...tail, prompt("p2"), reply("r2"), reply("r3")], [])).toBe(2);
  });

  it("counts a reply once as it moves from the head to the tail", () => {
    const tail = [reply("r1")];
    const mark = markSeenMessages(tail, []);
    expect(countNewMessages(mark, tail, [reply("r2")])).toBe(1);
    expect(countNewMessages(mark, [...tail, reply("r2")], [])).toBe(1);
  });

  it("does not count a reply that was already streaming when the reader scrolled up", () => {
    const tail = [reply("r1")];
    const mark = markSeenMessages(tail, [reply("r2")]);
    expect(countNewMessages(mark, tail, [reply("r2")])).toBe(0);
    expect(countNewMessages(mark, [...tail, reply("r2")], [])).toBe(0);
  });

  it("does not count older history paged in above the reader", () => {
    const tail = [reply("r5")];
    const mark = markSeenMessages(tail, []);
    expect(countNewMessages(mark, [reply("r3"), reply("r4"), ...tail], [])).toBe(0);
  });

  it("counts only the head when the reader's row is gone from a replaced timeline", () => {
    const mark = markSeenMessages([reply("r1")], []);
    expect(countNewMessages(mark, [reply("x1"), reply("x2")], [reply("r2")])).toBe(1);
  });

  it("counts every reply when the timeline was empty at the mark", () => {
    const mark = markSeenMessages([], []);
    expect(countNewMessages(mark, [reply("r1"), prompt("p1"), reply("r2")], [])).toBe(2);
  });
});
