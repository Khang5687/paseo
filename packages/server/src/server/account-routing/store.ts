import { readFileSync } from "node:fs";
import { OmpAccountRoutingPolicySchema } from "@getpaseo/protocol/messages";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { AccountRoutingPersistenceError, sameRef, type OmpAccountRoutingPolicy } from "./types.js";

export type PolicyDraft = Omit<OmpAccountRoutingPolicy, "policyRevision" | "selectionGeneration">;

export type CommitResult =
  | { kind: "committed"; policy: OmpAccountRoutingPolicy }
  | { kind: "noop"; policy: OmpAccountRoutingPolicy }
  | { kind: "conflict"; policy: OmpAccountRoutingPolicy };

const EMPTY_POLICY: OmpAccountRoutingPolicy = {
  policyRevision: 0,
  selectionGeneration: 0,
  current: null,
  autoEnabled: true,
  priorityOrder: [],
  inclusion: [],
};

function clonePolicy(policy: OmpAccountRoutingPolicy): OmpAccountRoutingPolicy {
  return structuredClone(policy);
}

function draftEquals(a: PolicyDraft, b: PolicyDraft): boolean {
  return (
    sameRef(a.current, b.current) &&
    a.autoEnabled === b.autoEnabled &&
    a.priorityOrder.length === b.priorityOrder.length &&
    a.priorityOrder.every((ref, i) => sameRef(ref, b.priorityOrder[i] ?? null)) &&
    a.inclusion.length === b.inclusion.length &&
    a.inclusion.every((entry, i) => {
      const other = b.inclusion[i];
      return (
        other !== undefined &&
        sameRef(entry.account, other.account) &&
        entry.included === other.included
      );
    })
  );
}

/**
 * Metadata-only durable routing policy at `$PASEO_HOME/account-routing.json`. The store owns
 * compare-and-set and atomic commit: the live copy changes only after the rename succeeded, so a
 * failed write leaves the former policy in place. No token, quota or admission data is persisted.
 */
export class AccountRoutingStore {
  private live: OmpAccountRoutingPolicy;

  private constructor(
    private readonly filePath: string,
    initial: OmpAccountRoutingPolicy,
  ) {
    this.live = initial;
  }

  /** An unreadable or invalid file throws; policy is never silently reset. */
  static open(filePath: string): AccountRoutingStore {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new AccountRoutingStore(filePath, clonePolicy(EMPTY_POLICY));
      }
      throw new AccountRoutingPersistenceError("Account routing policy could not be read.", {
        cause: error,
      });
    }
    const parsed = OmpAccountRoutingPolicySchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      throw new AccountRoutingPersistenceError("Account routing policy file is invalid.", {
        cause: parsed.error,
      });
    }
    return new AccountRoutingStore(filePath, parsed.data);
  }

  get policy(): OmpAccountRoutingPolicy {
    return clonePolicy(this.live);
  }

  /**
   * Compare-and-set. A stale `expectedRevision` returns the current policy without writing. An
   * unchanged draft is a no-op (no revision). `newSelection` forces a commit that bumps
   * selectionGeneration, which is how reselecting the same account is a new user decision.
   */
  commit(
    expectedRevision: number,
    draft: PolicyDraft,
    options: { newSelection?: boolean } = {},
  ): CommitResult {
    if (expectedRevision !== this.live.policyRevision) {
      return { kind: "conflict", policy: this.policy };
    }
    const selectionChanged =
      options.newSelection === true || !sameRef(draft.current, this.live.current);
    if (!selectionChanged && draftEquals(draft, this.live)) {
      return { kind: "noop", policy: this.policy };
    }
    const next: OmpAccountRoutingPolicy = {
      ...structuredClone(draft),
      policyRevision: this.live.policyRevision + 1,
      selectionGeneration: this.live.selectionGeneration + (selectionChanged ? 1 : 0),
    };
    try {
      writePrivateFileAtomicSync(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      throw new AccountRoutingPersistenceError("Account routing policy could not be saved.", {
        cause: error,
      });
    }
    this.live = next;
    return { kind: "committed", policy: this.policy };
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
