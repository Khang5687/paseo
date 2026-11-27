import { describe, expect, it } from "vitest";
import {
  IconRowOverflowStore,
  planIconRowOverflow,
  type IconRowButtonDisplay,
  type IconRowButtonPosition,
} from "./icon-row-overflow";

// The phone's default row: four built-ins, then three plugin buttons, in display order.
const ROW: IconRowButtonPosition[] = [
  { key: "new-workspace", itemOrder: 0, keepRank: 0, seq: 0 },
  { key: "history", itemOrder: 1, keepRank: 2, seq: 0 },
  { key: "search", itemOrder: 2, keepRank: 1, seq: 0 },
  { key: "schedules", itemOrder: 3, keepRank: 3, seq: 0 },
  { key: "tasks", itemOrder: 4, keepRank: 5, seq: 0 },
  { key: "accounts", itemOrder: 5, keepRank: 5, seq: 0 },
  { key: "approvals", itemOrder: 6, keepRank: 5, seq: 0 },
];

function display(label: string): IconRowButtonDisplay {
  return { label, icon: null, badge: null, testID: label };
}

describe("planIconRowOverflow", () => {
  it("keeps every button when they all fit", () => {
    expect(planIconRowOverflow(ROW, 7)).toEqual([]);
    expect(planIconRowOverflow(ROW, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("gives More the last slot and moves plugin buttons first, in display order", () => {
    // Six slots: five buttons stay, More takes the sixth.
    expect(planIconRowOverflow(ROW, 6)).toEqual(["accounts", "approvals"]);
  });

  it("moves the least used built-ins after the plugins, keeping New workspace and Search", () => {
    expect(planIconRowOverflow(ROW, 3)).toEqual([
      "history",
      "schedules",
      "tasks",
      "accounts",
      "approvals",
    ]);
  });

  it("keeps an item's buttons in their own order", () => {
    const bots: IconRowButtonPosition[] = [
      { key: "new-workspace", itemOrder: 0, keepRank: 0, seq: 1 },
      { key: "bot-2", itemOrder: 1, keepRank: 5, seq: 3 },
      { key: "bot-1", itemOrder: 1, keepRank: 5, seq: 2 },
    ];
    expect(planIconRowOverflow(bots, 2)).toEqual(["bot-1", "bot-2"]);
  });

  it("moves everything to More when not even one button fits beside it", () => {
    expect(planIconRowOverflow(ROW, 1)).toHaveLength(ROW.length);
  });
});

describe("IconRowOverflowStore", () => {
  function storeWithRow(slots: number): IconRowOverflowStore {
    const store = new IconRowOverflowStore();
    store.setSlots(slots);
    for (const { key, itemOrder, keepRank } of ROW) {
      store.register({ key, itemOrder, keepRank }, display(key), () => {});
    }
    return store;
  }

  it("moves buttons as the row narrows and brings them back as it widens", () => {
    const store = storeWithRow(Number.POSITIVE_INFINITY);
    expect(store.getEntries()).toEqual([]);
    store.setSlots(6);
    expect(store.getEntries().map((entry) => entry.key)).toEqual(["accounts", "approvals"]);
    expect(store.isOverflow("accounts")).toBe(true);
    expect(store.isOverflow("tasks")).toBe(false);
    store.setSlots(8);
    expect(store.getEntries()).toEqual([]);
    expect(store.isOverflow("accounts")).toBe(false);
  });

  it("presses the latest handler and shows the latest label of a button in More", () => {
    const store = storeWithRow(6);
    const pressed: string[] = [];
    store.unregister("approvals");
    store.register({ key: "approvals", itemOrder: 6, keepRank: 5 }, display("approvals"), () =>
      pressed.push("approvals"),
    );
    store.updateDisplay("approvals", { ...display("approvals"), label: "Send approvals (2)" });
    const entry = store.getEntries().find((candidate) => candidate.key === "approvals");
    expect(entry?.label).toBe("Send approvals (2)");
    entry?.press();
    expect(pressed).toEqual(["approvals"]);
  });

  it("notifies only when what More shows changes", () => {
    const store = storeWithRow(6);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.updateDisplay("accounts", display("accounts"));
    store.updateDisplay("tasks", { ...display("tasks"), label: "Tasks (1)" });
    store.setSlots(6);
    expect(notified).toBe(0);
    store.updateDisplay("accounts", { ...display("accounts"), badge: { tone: "attention" } });
    expect(notified).toBe(1);
  });
});
