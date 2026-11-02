import { describe, expect, it } from "vitest";
import type { OmpAccountRoutingState } from "@getpaseo/protocol/messages";
import { AddAccountFlow, billingNote, describeAddAccount } from "./add-account-flow";
import type { LoginSnapshot } from "./queries";

const IDLE: LoginSnapshot = {
  phase: "idle",
  failure: null,
  step: null,
  authorizeUrl: null,
  pasteAccepted: false,
  outcome: null,
  endedAt: null,
  submitting: false,
  pasteError: null,
  justAdded: null,
};
const LOCAL = { pasteOpen: false, pasteText: "" };
const ref = { storeNamespace: "s", nativeRowId: 1 };

function account(label: string, billing: "enabled" | "disabled" | "unknown", row = 1) {
  return {
    ref: { storeNamespace: "s", nativeRowId: row },
    label,
    billing: { state: billing },
  } as unknown as OmpAccountRoutingState["accounts"][number];
}

const view = (
  login: Partial<LoginSnapshot>,
  accounts = [] as OmpAccountRoutingState["accounts"],
  local = LOCAL,
) => describeAddAccount({ ...IDLE, ...login }, accounts, local);

describe("describeAddAccount steps", () => {
  it("starts at the warning and lists the accounts already added once each", () => {
    const v = view({}, [account("a@x.com", "disabled"), account("a@x.com", "disabled", 2)]);
    expect(v).toMatchObject({ step: "warning", existingLabels: ["a@x.com"], result: null });
  });

  it("follows the host: preparing, link, verifying", () => {
    expect(view({ phase: "starting", step: "preparing" }).step).toBe("preparing");
    expect(view({ phase: "running", step: "preparing" }).step).toBe("preparing");
    expect(view({ phase: "running", step: "verifying" }).step).toBe("verifying");
    const link = view({
      phase: "running",
      step: "awaiting_browser",
      authorizeUrl: "https://claude.ai/a",
    });
    expect(link).toMatchObject({ step: "link", authorizeUrl: "https://claude.ai/a" });
  });

  it("waits in preparing until the link arrives", () => {
    expect(view({ phase: "running", step: "awaiting_browser", authorizeUrl: null }).step).toBe(
      "preparing",
    );
  });

  it("offers the paste field only while OMP's prompt is open", () => {
    const base = {
      phase: "running",
      step: "awaiting_browser",
      authorizeUrl: "https://c/a",
    } as const;
    const closed = view(base, [], { pasteOpen: true, pasteText: "x" });
    expect(closed).toMatchObject({ canPaste: false, pasteOpen: false, canSubmit: false });
    const open = view({ ...base, pasteAccepted: true }, [], { pasteOpen: true, pasteText: " x " });
    expect(open).toMatchObject({ canPaste: true, pasteOpen: true, canSubmit: true });
    expect(
      view({ ...base, pasteAccepted: true }, [], { pasteOpen: true, pasteText: "  " }).canSubmit,
    ).toBe(false);
    expect(
      view({ ...base, pasteAccepted: true, submitting: true }, [], {
        pasteOpen: true,
        pasteText: "x",
      }).canSubmit,
    ).toBe(false);
  });

  it("carries the paste error to the field", () => {
    expect(
      view({
        phase: "running",
        step: "awaiting_browser",
        authorizeUrl: "https://c",
        pasteAccepted: true,
        pasteError: "wrong_login",
      }).pasteError,
    ).toBe("wrong_login");
  });
});

describe("describeAddAccount results", () => {
  it("added, with the billing line from the catalog", () => {
    const outcome = { kind: "added", label: "b@x.com", organizationLabel: "Org", ref } as const;
    const enabled = view({ phase: "succeeded", outcome }, [account("b@x.com", "enabled")]);
    expect(enabled.result).toMatchObject({
      kind: "added",
      label: "b@x.com",
      organization: "Org",
      billing: "enabled",
    });
    expect(
      view({ phase: "succeeded", outcome }, [account("b@x.com", "disabled")]).result?.billing,
    ).toBeNull();
    expect(
      view({ phase: "succeeded", outcome }, [account("b@x.com", "unknown")]).result?.billing,
    ).toBe("unknown");
  });

  it("treats a row the catalog has not shown yet as billing unknown", () => {
    expect(billingNote(ref, [])).toBe("unknown");
    expect(billingNote(undefined, [account("a", "disabled")])).toBe("unknown");
  });

  it("already added is a failed login that changed nothing", () => {
    const real = view({
      phase: "failed",
      failure: "omp_failed",
      outcome: { kind: "already_listed", label: "a@x.com" },
    });
    expect(real.result).toMatchObject({ kind: "alreadyListed", label: "a@x.com" });
  });

  it("replaced and cancelled", () => {
    expect(view({ phase: "succeeded", outcome: { kind: "replaced" } }).result?.kind).toBe(
      "replaced",
    );
    expect(view({ phase: "cancelled" }).result?.kind).toBe("cancelled");
  });

  it("a success with no outcome from an older host reads as added without a name", () => {
    expect(view({ phase: "succeeded" }).result).toMatchObject({ kind: "added", label: null });
  });

  it("failures map to copy the daemon still sends; retired ones read as an OMP failure", () => {
    for (const failure of ["timeout", "omp_failed", "spawn_failed", "unreachable"] as const) {
      expect(view({ phase: "failed", failure }).result).toMatchObject({ kind: "failed", failure });
    }
    for (const failure of ["paste_code_unsupported", "browser_open_failed"] as const) {
      expect(view({ phase: "failed", failure }).result?.failure).toBe("omp_failed");
    }
  });
});

describe("AddAccountFlow", () => {
  it("holds the paste field state and clears it on reset", () => {
    const flow = new AddAccountFlow();
    let calls = 0;
    flow.subscribe(() => calls++);
    flow.openPaste();
    flow.setPasteText("abc");
    expect(flow.getState()).toEqual({ pasteOpen: true, pasteText: "abc" });
    flow.reset();
    expect(flow.getState()).toEqual({ pasteOpen: false, pasteText: "" });
    expect(calls).toBe(3);
  });
});
