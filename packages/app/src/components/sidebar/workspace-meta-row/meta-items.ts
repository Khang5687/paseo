import type { WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";
import type { PrHint } from "@/git/pr-hint";
import type { SidebarChecksDisplay } from "@/components/sidebar/display-preferences/checks-display";
import type { SidebarRowItems } from "@/components/sidebar/display-preferences/row-items";
import { selectCheckSummary, type CheckSummary } from "./check-summary";
import type { WorkspaceServiceSummary } from "./service-summary";
import type { WaitCounts } from "@/workspace-status/waiting-label";

/**
 * What ends up on the line under a workspace title, in the order it is read: what the working
 * chat waits on, where the workspace lives, what change it belongs to, whether that change is
 * passing, what it is running, when a heartbeat next wakes it, and what someone filed it under.
 * A wait leads because it explains the hourglass in the status slot beside it; then identity,
 * then the work, then the work's state, then the labels a person put on it.
 *
 * On a phone, what a settled chat waits on (its background jobs and subagents) leads the same
 * way: there is no hover there to explain the hourglass. A desktop row leaves it to the
 * hourglass's tooltip. It is not a toggle, because it is status rather than identity.
 *
 * Labels are one item rather than one per label: they are drawn as a run of chips with a single
 * separator in front of them, so the line reads as four peers however many labels a workspace
 * carries.
 */
export type MetaRowItem =
  | { kind: "waitingFor"; wait: WaitCounts }
  | { kind: "branch"; name: string }
  | { kind: "project"; name: string }
  | { kind: "host" }
  | { kind: "changeRequest"; hint: PrHint }
  | { kind: "checks"; summary: CheckSummary; label: boolean }
  | { kind: "services"; summary: WorkspaceServiceSummary }
  | { kind: "nextRun"; at: string }
  | { kind: "waiting"; title: string }
  | { kind: "labels"; labels: readonly WorkspaceLabelDefinition[] };

/**
 * Which peers a row should draw, given what it knows and what the user left switched on.
 *
 * Kept out of the component because this — not the markup — is the part with rules in it: every
 * toggle answers for itself, so a row can end up showing checks with no change request beside
 * them, and CI resolves from the hint even when the hint itself is not drawn.
 *
 * The host is filtered upstream, where the badge map is built: a host that should show nothing
 * has no badge to hand down, so by the time a row sees one it is meant to be drawn.
 */
export function selectMetaRowItems(input: {
  currentBranch: string | null;
  projectName: string | null;
  hasHostBadge: boolean;
  prHint: PrHint | null;
  serviceSummary: WorkspaceServiceSummary | null;
  /** A scheduled heartbeat. Not a preference: it is why an idle row will start working again. */
  nextRunAt: string | null;
  /** The job the working chat waits on; "" when unnamed. Not a preference either. */
  waitingOn: string | null;
  labels: readonly WorkspaceLabelDefinition[];
  visible: SidebarRowItems;
  checksDisplay: SidebarChecksDisplay;
  /** The jobs and subagents a settled chat waits on, when the row should say so in words. */
  waitingFor?: WaitCounts | null;
}): MetaRowItem[] {
  const {
    waitingFor = null,
    currentBranch,
    projectName,
    hasHostBadge,
    prHint,
    serviceSummary,
    nextRunAt,
    waitingOn,
    labels,
    visible,
    checksDisplay,
  } = input;
  const items: MetaRowItem[] = [];

  if (waitingOn !== null) {
    items.push({ kind: "waiting", title: waitingOn });
  } else if (waitingFor !== null) {
    items.push({ kind: "waitingFor", wait: waitingFor });
  }
  if (currentBranch && visible.branch) {
    items.push({ kind: "branch", name: currentBranch });
  }
  if (projectName && visible.project) {
    items.push({ kind: "project", name: projectName });
  }
  if (hasHostBadge) {
    items.push({ kind: "host" });
  }
  if (prHint && visible.changeRequest) {
    items.push({ kind: "changeRequest", hint: prHint });
  }

  // Independent of the change request, even though checks are read off one. Tying them together
  // meant the checks setting could sit on a value while nothing was drawn, which is a control that
  // lies about its own state. Showing checks without the change request beside them is the
  // stranger combination, but it is the one you asked for and it is what you get.
  if (checksDisplay !== "none") {
    const summary = selectCheckSummary(prHint);
    if (summary) {
      items.push({ kind: "checks", summary, label: checksDisplay === "iconAndText" });
    }
  }

  if (serviceSummary && visible.services) {
    items.push({ kind: "services", summary: serviceSummary });
  }

  if (nextRunAt) {
    items.push({ kind: "nextRun", at: nextRunAt });
  }

  if (labels.length > 0 && visible.labels) {
    items.push({ kind: "labels", labels });
  }

  return items;
}
