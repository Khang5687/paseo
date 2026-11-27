import { beforeEach, describe, expect, it } from "vitest";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { saveWorkspaceReorder } from "./workspace-reorder";

const shownOrders = [
  { projectViewKey: "alpha", workspaceKeys: ["h:3", "h:1", "h:2"] },
  { projectViewKey: "beta", workspaceKeys: ["h:5", "h:4"] },
];

describe("saveWorkspaceReorder", () => {
  beforeEach(() => {
    useSidebarOrderStore.setState({
      workspaceOrderByProject: {},
      workspaceOrderUpdatedAtByProject: {},
    });
    useSidebarViewStore.setState({ workspaceSort: "created", workspaceSortUpdatedAt: 0 });
  });

  it("switches another sort to Manual, keeping every project's order as shown", () => {
    const result = saveWorkspaceReorder({
      projectViewKey: "alpha",
      reorderedKeys: ["h:1", "h:3", "h:2"],
      shownOrders,
    });

    expect(result.switchedToManual).toBe(true);
    const view = useSidebarViewStore.getState();
    expect(view.workspaceSort).toBe("manual");
    expect(view.workspaceSortUpdatedAt).toBeGreaterThan(0);
    const orders = useSidebarOrderStore.getState();
    expect(orders.workspaceOrderByProject).toEqual({
      alpha: ["h:1", "h:3", "h:2"],
      beta: ["h:5", "h:4"],
    });
    // Stamped, so every device takes the new manual order with the sort.
    expect(Object.keys(orders.workspaceOrderUpdatedAtByProject).sort()).toEqual(["alpha", "beta"]);
  });

  it("changes nothing when the row lands where it started", () => {
    const result = saveWorkspaceReorder({
      projectViewKey: "alpha",
      reorderedKeys: ["h:3", "h:1", "h:2"],
      shownOrders,
    });

    expect(result.switchedToManual).toBe(false);
    expect(useSidebarViewStore.getState().workspaceSort).toBe("created");
    expect(useSidebarOrderStore.getState().workspaceOrderByProject).toEqual({});
  });

  it("under Manual reorders only the dragged project", () => {
    useSidebarViewStore.setState({ workspaceSort: "manual", workspaceSortUpdatedAt: 5 });
    useSidebarOrderStore.setState({
      workspaceOrderByProject: { alpha: ["h:1", "h:2", "h:3"], beta: ["h:4", "h:5"] },
    });

    const result = saveWorkspaceReorder({
      projectViewKey: "alpha",
      reorderedKeys: ["h:2", "h:1"],
      shownOrders,
    });

    expect(result.switchedToManual).toBe(false);
    expect(useSidebarViewStore.getState().workspaceSortUpdatedAt).toBe(5);
    expect(useSidebarOrderStore.getState().workspaceOrderByProject).toEqual({
      alpha: ["h:2", "h:1", "h:3"],
      beta: ["h:4", "h:5"],
    });
    expect(Object.keys(useSidebarOrderStore.getState().workspaceOrderUpdatedAtByProject)).toEqual([
      "alpha",
    ]);
  });
});
