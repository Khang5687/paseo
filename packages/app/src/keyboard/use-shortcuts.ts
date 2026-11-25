import { usesDesktopBindings } from "./internal/conventions";
import { createKeyboardPipeline } from "./internal/pipeline";
import { overlays } from "./internal/overlays";
import { heldModifiers } from "./internal/press-modifiers";
import { attachKeyboardSources, publishKeyboardPolicy } from "./internal/sources";
import type { KeyboardSourceInput } from "./internal/sources/contract";
import type { KeyboardInputEvent } from "./internal/overlays";
import { hasActiveOverlay } from "./internal/overlay-dispatch";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "expo-router";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";
import {
  type ChordState,
  type ShortcutBadgeModifiers,
  buildEffectiveBindings,
  getIndexJumpBadgeModifiers,
  resolveShortcutBadgeTarget,
} from "@/keyboard/keyboard-shortcuts";
import { shouldPublishBrowserShortcutPolicy } from "@/keyboard/internal/sources/electron-browser";
import type { KeyboardShortcutPayload } from "@/keyboard/actions";
import {
  routeKeyboardShortcut,
  type ShortcutAction,
  type ShortcutCallbackName,
} from "@/keyboard/route-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import {
  type ActiveWorkspaceSelection,
  navigateToLastWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { usePanelStore } from "@/stores/panel-store";

const MODIFIER_FLAG_BY_KEY: Record<string, keyof ShortcutBadgeModifiers> = {
  Meta: "meta",
  Control: "ctrl",
  Alt: "alt",
  Shift: "shift",
};

/**
 * The modifiers held after this key event. The event's own flags can lag for
 * the modifier being pressed or released, so that key's flag is set from the
 * event type instead.
 */
function heldModifiersAfter(event: KeyboardInputEvent, down: boolean): ShortcutBadgeModifiers {
  const held = {
    meta: Boolean(event.metaKey),
    ctrl: Boolean(event.ctrlKey),
    alt: Boolean(event.altKey),
    shift: Boolean(event.shiftKey),
  };
  const flag = MODIFIER_FLAG_BY_KEY[event.key ?? ""];
  if (flag) held[flag] = down;
  return held;
}

export function useKeyboardShortcuts({
  enabled,
  isMobile,
  isWorkspaceFocusModeEnabled,
  toggleAgentList,
  toggleBothSidebars,
  exitFocusMode,
  cycleTheme,
}: {
  enabled: boolean;
  isMobile: boolean;
  isWorkspaceFocusModeEnabled: boolean;
  toggleAgentList: () => void;
  toggleBothSidebars?: () => void;
  exitFocusMode: () => void;
  cycleTheme?: () => void;
}) {
  const keyboardActionDispatcher = useKeyboardActionDispatcher();
  const pathname = usePathname();
  const router = useRouter();
  const resetModifiers = useKeyboardShortcutsStore((s) => s.resetModifiers);
  const { overrides } = useKeyboardShortcutOverrides();
  const bindings = useMemo(() => buildEffectiveBindings(overrides), [overrides]);
  const isMac = getShortcutOs() === "mac";
  const openProjectPickerAction = useOpenAddProject();
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const keyboardWorkspaceSelectionRef = useRef<ActiveWorkspaceSelection | null>(null);
  const publishBrowserShortcutPolicy = useCallback(
    (chordState?: ChordState) => {
      publishKeyboardPolicy({ bindings, chordState, isMac, usesDesktopBindings, enabled });
    },
    [bindings, enabled, isMac],
  );

  useEffect(() => {
    if (activeWorkspaceSelection) {
      keyboardWorkspaceSelectionRef.current = activeWorkspaceSelection;
    }
  }, [activeWorkspaceSelection]);

  useEffect(() => {
    publishBrowserShortcutPolicy();
  }, [publishBrowserShortcutPolicy]);

  // Holding the modifiers of a digit jump reveals that group's number badges:
  // the project strip for the plain group, the sidebar rows for the one with
  // Alt added. Derived from the effective bindings, so a group the user
  // unassigned or rebound to one concrete digit never shows badges.
  const badgeGroups = useMemo(() => {
    const platform = { isMac, usesDesktopBindings };
    return {
      project: getIndexJumpBadgeModifiers("project", platform, bindings),
      workspace: getIndexJumpBadgeModifiers("workspace", platform, bindings),
    };
  }, [bindings, isMac]);

  // A modifier held while the jump bindings change could leave its badges up
  // until a blur. Clear them when the groups change.
  useEffect(() => {
    resetModifiers();
  }, [badgeGroups, resetModifiers]);

  const updateHeldBadgeTarget = (event: KeyboardInputEvent, down: boolean) => {
    if (!MODIFIER_FLAG_BY_KEY[event.key ?? ""]) return;
    useKeyboardShortcutsStore
      .getState()
      .setHeldBadgeTarget(resolveShortcutBadgeTarget(heldModifiersAfter(event, down), badgeGroups));
  };

  const callbacksByName: Record<ShortcutCallbackName, (() => void) | undefined> = {
    "toggle-agent-list": toggleAgentList,
    "toggle-both-sidebars": toggleBothSidebars,
    "cycle-theme": cycleTheme,
  };

  const performShortcutAction = (
    action: ShortcutAction,
    captureFocusRestore: () => void,
  ): boolean => {
    switch (action.kind) {
      case "none":
        return false;
      case "dispatch":
        return keyboardActionDispatcher.dispatch(action.action);
      case "navigate-workspace":
        keyboardWorkspaceSelectionRef.current = {
          serverId: action.serverId,
          workspaceId: action.workspaceId,
        };
        navigateToWorkspace({ serverId: action.serverId, workspaceId: action.workspaceId });
        return true;
      case "navigate-last-workspace":
        if (navigateToLastWorkspace()) {
          return true;
        }
        router.replace(buildOpenProjectRoute());
        return true;
      case "router-replace":
        router.replace(action.route as Parameters<typeof router.replace>[0]);
        return true;
      case "router-back":
        router.back();
        return true;
      case "router-push":
        router.push(action.route as Parameters<typeof router.push>[0]);
        return true;
      case "open-project-picker":
        void openProjectPickerAction();
        return true;
      case "callback":
        callbacksByName[action.name]?.();
        return true;
      case "command-center-toggle": {
        if (action.nextOpen) {
          captureFocusRestore();
        }
        useKeyboardShortcutsStore.getState().setCommandCenterOpen(action.nextOpen, action.tab);
        return true;
      }
      case "shortcuts-dialog-toggle":
        useKeyboardShortcutsStore.getState().setShortcutsDialogOpen(action.nextOpen);
        return true;
      case "show-sidebar-project":
        useSidebarViewStore.getState().showOnlyProject(action.projectViewKey);
        usePanelStore.getState().openAgentListForLayout({ isCompact: isMobile });
        if (action.lastChat) {
          navigateToWorkspace(action.lastChat);
        }
        return true;
    }
  };

  const routeAndPerformShortcut = (input: {
    action: string;
    payload: KeyboardShortcutPayload;
    captureFocusRestore: () => void;
  }): boolean => {
    const store = useKeyboardShortcutsStore.getState();
    const shortcutAction = routeKeyboardShortcut(
      { action: input.action, payload: input.payload },
      {
        pathname,
        isMobile,
        sidebarShortcutTargets: store.sidebarShortcutWorkspaceTargets,
        sidebarShortcutProjects: store.sidebarShortcutProjects,
        navigationActiveWorkspace:
          keyboardWorkspaceSelectionRef.current ?? activeWorkspaceSelection,
        commandCenterOpen: store.commandCenterOpen,
        shortcutsDialogOpen: store.shortcutsDialogOpen,
      },
    );
    const handled = performShortcutAction(shortcutAction, input.captureFocusRestore);
    if (handled && isWorkspaceFocusModeEnabled && input.action.startsWith("sidebar.")) {
      exitFocusMode();
    }
    return handled;
  };

  const getContext = useStableEvent(() => ({
    isMac,
    usesDesktopBindings: usesDesktopBindings,
    commandCenterOpen: useKeyboardShortcutsStore.getState().commandCenterOpen,
  }));
  const getBindings = useStableEvent(() => bindings);
  const isCapturing = useStableEvent(() => useKeyboardShortcutsStore.getState().capturingShortcut);
  const dispatchMatch = useStableEvent(
    (match: import("./keyboard-shortcuts").KeyboardShortcutMatch, input: KeyboardSourceInput) =>
      routeAndPerformShortcut({
        action: match.action,
        payload: match.payload,
        captureFocusRestore: input.captureFocusRestore,
      }),
  );
  const chordChanged = useStableEvent(
    (previous: ChordState, next: ChordState, input: KeyboardSourceInput | null) => {
      const isBrowserInput = input !== null && "browserId" in input.event;
      if (
        !input ||
        shouldPublishBrowserShortcutPolicy({
          isBrowserInput,
          previousChordState: previous,
          nextChordState: next,
        })
      ) {
        publishBrowserShortcutPolicy(next);
      }
    },
  );
  const beforeResolve = useStableEvent((input: KeyboardSourceInput) => {
    const event = input.event;
    const key = event.key ?? "";
    if (key === "Escape" && pathname.startsWith("/settings") && !isMobile && hasActiveOverlay()) {
      return false;
    }
    updateHeldBadgeTarget(event, true);

    return true;
  });

  const pipeline = useMemo(
    () =>
      createKeyboardPipeline({
        getContext,
        getBindings,
        isCapturing,
        dispatch: dispatchMatch,
        overlays,
        beforeResolve,
        chordChanged,
      }),
    [getContext, getBindings, isCapturing, dispatchMatch, beforeResolve, chordChanged],
  );

  const handleKeyDown = useStableEvent((input: KeyboardSourceInput) => {
    heldModifiers.handleKeyDown(input.event);
    return pipeline.keyDown(input);
  });

  const handleKeyUp = useStableEvent((event: KeyboardInputEvent) => {
    heldModifiers.handleKeyUp(event);
    updateHeldBadgeTarget(event, false);
  });

  const handleBlur = useStableEvent(() => {
    heldModifiers.reset();
    resetModifiers();
  });

  useEffect(() => {
    if (!enabled) return;
    const detach = attachKeyboardSources({
      keyDown: handleKeyDown,
      keyUp: handleKeyUp,
      blur: handleBlur,
      commandCenterOpen: () => useKeyboardShortcutsStore.getState().commandCenterOpen,
      subscribeCommandCenter: (listener) =>
        useKeyboardShortcutsStore.subscribe((state, previous) => {
          if (state.commandCenterOpen !== previous.commandCenterOpen) listener();
        }),
    });
    return () => {
      detach();
      heldModifiers.reset();
      pipeline.dispose();
    };
  }, [enabled, pipeline, handleKeyDown, handleKeyUp, handleBlur]);
}
