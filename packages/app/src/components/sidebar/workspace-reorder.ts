import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";

export interface ShownWorkspaceOrder {
  projectViewKey: string;
  /** The project's workspaces in the order the sidebar shows them now. */
  workspaceKeys: string[];
}

/**
 * Saves a drag in one project's workspace list. A drag works under every sort: when the sort is
 * not Manual, it becomes Manual for every device, and each project keeps the order it shows now
 * as its manual order, so only the dragged row moves. Returns whether the sort switched.
 */
export function saveWorkspaceReorder(input: {
  projectViewKey: string;
  reorderedKeys: string[];
  shownOrders: readonly ShownWorkspaceOrder[];
}): { switchedToManual: boolean } {
  const view = useSidebarViewStore.getState();
  const orderStore = useSidebarOrderStore.getState();
  const manual = view.workspaceSort === "manual";
  const currentOrder = manual
    ? orderStore.getWorkspaceOrder(input.projectViewKey)
    : (input.shownOrders.find((shown) => shown.projectViewKey === input.projectViewKey)
        ?.workspaceKeys ?? []);
  if (!hasVisibleOrderChanged({ currentOrder, reorderedVisibleKeys: input.reorderedKeys })) {
    return { switchedToManual: false };
  }

  const orders: Record<string, string[]> = {};
  if (!manual) {
    for (const shown of input.shownOrders) orders[shown.projectViewKey] = shown.workspaceKeys;
  }
  orders[input.projectViewKey] = mergeWithRemainder({
    currentOrder,
    reorderedVisibleKeys: input.reorderedKeys,
  });
  orderStore.setWorkspaceOrders(orders);
  if (manual) return { switchedToManual: false };
  view.setWorkspaceSort("manual");
  return { switchedToManual: true };
}
