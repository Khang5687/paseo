import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountRoutingStore, type PolicyDraft } from "./store.js";
import { AccountRoutingPersistenceError } from "./types.js";

const A = { storeNamespace: "ns", nativeRowId: 1 };
const B = { storeNamespace: "ns", nativeRowId: 2 };

function draftOf(store: AccountRoutingStore, patch: Partial<PolicyDraft> = {}): PolicyDraft {
  const { policyRevision: _r, selectionGeneration: _g, ...rest } = store.policy;
  return { ...rest, ...patch };
}

describe("AccountRoutingStore", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "routing-store-"));
    file = path.join(dir, "account-routing.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts from defaults when the file is absent", () => {
    expect(AccountRoutingStore.open(file).policy).toEqual({
      policyRevision: 0,
      selectionGeneration: 0,
      current: null,
      autoEnabled: true,
      priorityOrder: [],
      inclusion: [],
    });
  });

  it("fails closed on an invalid file instead of resetting it", () => {
    writeFileSync(file, "{not json");
    expect(() => AccountRoutingStore.open(file)).toThrow(AccountRoutingPersistenceError);
    writeFileSync(file, JSON.stringify({ policyRevision: -1 }));
    expect(() => AccountRoutingStore.open(file)).toThrow(AccountRoutingPersistenceError);
    expect(readFileSync(file, "utf8")).toContain("policyRevision");
  });

  it("commits once per change and restores from disk", () => {
    const store = AccountRoutingStore.open(file);
    const result = store.commit(0, draftOf(store, { current: A, priorityOrder: [A, B] }));
    expect(result.kind).toBe("committed");
    expect(result.policy).toMatchObject({ policyRevision: 1, selectionGeneration: 1, current: A });
    expect(AccountRoutingStore.open(file).policy).toEqual(result.policy);
    expect(readdirSync(dir)).toEqual(["account-routing.json"]);
  });

  it("returns a conflict with the current policy and writes nothing on a stale revision", () => {
    const store = AccountRoutingStore.open(file);
    store.commit(0, draftOf(store, { autoEnabled: false }));
    const before = readFileSync(file, "utf8");
    const stale = store.commit(0, draftOf(store, { autoEnabled: true }));
    expect(stale.kind).toBe("conflict");
    expect(stale.policy.autoEnabled).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("treats an identical draft as a no-op with no revision bump", () => {
    const store = AccountRoutingStore.open(file);
    store.commit(0, draftOf(store, { current: A, priorityOrder: [A] }));
    const noop = store.commit(1, draftOf(store));
    expect(noop.kind).toBe("noop");
    expect(noop.policy.policyRevision).toBe(1);
  });

  it("bumps selectionGeneration only for a real or forced selection", () => {
    const store = AccountRoutingStore.open(file);
    store.commit(0, draftOf(store, { current: A }));
    const reorder = store.commit(1, draftOf(store, { priorityOrder: [A, B] }));
    expect(reorder.policy).toMatchObject({ policyRevision: 2, selectionGeneration: 1 });
    const same = store.commit(2, draftOf(store, { current: A }), { newSelection: true });
    expect(same.kind).toBe("committed");
    expect(same.policy).toMatchObject({ policyRevision: 3, selectionGeneration: 2 });
    const moved = store.commit(3, draftOf(store, { current: B }));
    expect(moved.policy).toMatchObject({ policyRevision: 4, selectionGeneration: 3 });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the former live policy and file when the write fails",
    () => {
      const store = AccountRoutingStore.open(file);
      store.commit(0, draftOf(store, { current: A }));
      const before = readFileSync(file, "utf8");
      rmSync(file);
      mkdirSync(file); // a directory where the file belongs makes the rename fail
      expect(() => store.commit(1, draftOf(store, { current: B }))).toThrow(
        AccountRoutingPersistenceError,
      );
      expect(store.policy.current).toEqual(A);
      expect(store.policy.policyRevision).toBe(1);
      rmSync(file, { recursive: true });
      writeFileSync(file, before);
      expect(readdirSync(dir)).toEqual(["account-routing.json"]);
      expect(store.commit(1, draftOf(store, { current: B })).kind).toBe("committed");
    },
  );
});
