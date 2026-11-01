import { describe, expect, it } from "vitest";
import {
  type CollapsedProjectsState,
  createDefaultCollapsedProjectsState,
  mergePersistedCollapsedProjects,
  serializeCollapsedProjects,
  setProjectCollapsed,
  togglePinnedCollapsed,
  toggleProjectCollapsed,
  toggleThreadExpanded,
  toggleSettledCollapsed,
  toggleWorkspaceGroupCollapsed,
} from "@/stores/sidebar-collapsed-sections-store/state";

function emptyState(): CollapsedProjectsState {
  return {
    collapsedProjectKeys: new Set(),
    collapsedWorkspaceGroupKeys: new Set(),
    collapsedPinned: false,
    expandedThreadKeys: new Set(),
    collapsedSettled: false,
  };
}

describe("sidebar collapsed projects transitions", () => {
  it("starts threads folded and remembers the ones the user unfolds", () => {
    let state = toggleThreadExpanded(emptyState(), "srv:a");
    state = toggleThreadExpanded(state, "srv:b");
    state = toggleThreadExpanded(state, "srv:a");

    expect(Array.from(state.expandedThreadKeys)).toEqual(["srv:b"]);
    const restored = mergePersistedCollapsedProjects(
      serializeCollapsedProjects(state),
      emptyState(),
    );
    expect(Array.from(restored.expandedThreadKeys)).toEqual(["srv:b"]);
  });

  it("tracks collapsed project keys as a Set", () => {
    let state = emptyState();

    state = setProjectCollapsed(state, "project-a", true);
    state = toggleProjectCollapsed(state, "project-b");
    state = toggleProjectCollapsed(state, "project-a");
    state = toggleWorkspaceGroupCollapsed(state, "running");

    expect(Array.from(state.collapsedProjectKeys)).toEqual(["project-b"]);
    expect(Array.from(state.collapsedWorkspaceGroupKeys)).toEqual(["running"]);
  });

  it("serializes collapsed project keys for preference storage", () => {
    const state: CollapsedProjectsState = {
      collapsedProjectKeys: new Set(["project-a", "project-b"]),
      collapsedWorkspaceGroupKeys: new Set(["running"]),
      collapsedPinned: true,
      expandedThreadKeys: new Set(["srv:thread"]),
      collapsedSettled: false,
    };

    expect(serializeCollapsedProjects(state)).toEqual({
      collapsedProjectKeys: ["project-a", "project-b"],
      collapsedWorkspaceGroupKeys: ["running"],
      collapsedPinned: true,
      expandedThreadKeys: ["srv:thread"],
      collapsedSettled: false,
    });
  });

  it("toggles and restores the pinned section collapse flag", () => {
    const toggled = togglePinnedCollapsed(emptyState());
    expect(toggled.collapsedPinned).toBe(true);

    const restored = mergePersistedCollapsedProjects({ collapsedPinned: true }, emptyState());
    expect(restored.collapsedPinned).toBe(true);
  });

  it("starts the settled section collapsed, also under storage written before it", () => {
    const initial = createDefaultCollapsedProjectsState();
    expect(initial.collapsedSettled).toBe(true);

    const restored = mergePersistedCollapsedProjects({ collapsedPinned: true }, initial);
    expect(restored.collapsedSettled).toBe(true);
  });

  it("restores an expanded settled section across a reload", () => {
    const expanded = toggleSettledCollapsed(createDefaultCollapsedProjectsState());
    expect(expanded.collapsedSettled).toBe(false);

    const restored = mergePersistedCollapsedProjects(
      serializeCollapsedProjects(expanded),
      createDefaultCollapsedProjectsState(),
    );
    expect(restored.collapsedSettled).toBe(false);
  });

  it("rejects the complete value when a persisted project key is invalid", () => {
    const restored = mergePersistedCollapsedProjects(
      { collapsedProjectKeys: ["project-a", "project-b", 42] },
      emptyState(),
    );

    expect(Array.from(restored.collapsedProjectKeys)).toEqual([]);
    expect(Array.from(restored.collapsedWorkspaceGroupKeys)).toEqual([]);
  });

  it("keeps the existing state object when persisted preferences do not change collapsed keys", () => {
    const currentState = emptyState();

    expect(mergePersistedCollapsedProjects(undefined, currentState)).toBe(currentState);
    expect(mergePersistedCollapsedProjects({}, currentState)).toBe(currentState);
    expect(mergePersistedCollapsedProjects({ collapsedProjectKeys: [] }, currentState)).toBe(
      currentState,
    );
  });
});
