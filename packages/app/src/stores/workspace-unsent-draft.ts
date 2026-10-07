import { buildTabDraftStoreKey } from "@/stores/draft-keys";
import type { DraftRecord } from "@/stores/draft-store/state";
import { collectAllTabs, type WorkspaceLayout } from "@/stores/workspace-layout-actions";

/** Draft keys of every composer tab open in a workspace, in tab order. */
export function collectWorkspaceDraftKeys(
  serverId: string,
  layout: WorkspaceLayout | undefined,
): string[] {
  if (!layout) {
    return [];
  }
  const draftKeys: string[] = [];
  for (const tab of collectAllTabs(layout.root)) {
    const draftKey = buildTabDraftStoreKey({ serverId, tabId: tab.tabId, target: tab.target });
    if (draftKey) {
      draftKeys.push(draftKey);
    }
  }
  return draftKeys;
}

/**
 * A prompt the user started and has not sent. Whitespace alone is not a prompt; an
 * attachment on its own is, because the user picked it on purpose.
 */
export function isUnsentDraft(record: DraftRecord | undefined): boolean {
  return (
    record?.lifecycle === "active" &&
    (record.input.text.trim().length > 0 || record.input.attachments.length > 0)
  );
}
