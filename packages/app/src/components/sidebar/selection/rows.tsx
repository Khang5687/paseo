import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { View, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import { densityIconBox, densityIconProps } from "@/styles/density";
import { useSidebarSelectionStore } from "@/stores/sidebar-selection-store";
import {
  resolveSidebarRowPressIntent,
  type SidebarRowPressModifiers,
} from "@/stores/sidebar-selection-store/state";
import { getShortcutOs } from "@/utils/shortcut-platform";

const ThemedCheck = withUnistyles(Check);
const checkIconProps = densityIconProps("xs", (theme) => ({
  color: theme.colors.accentForeground,
}));

/**
 * What a Shift-click needs and a single row cannot see: the rows on screen, in sidebar order.
 * Rows register while mounted, so rows inside a collapsed group or past a "Show more" limit
 * are never part of a range, and a range never archives something the user could not see.
 */
interface SidebarRowOrder {
  register: (workspaceKey: string) => () => void;
  getVisibleKeys: () => string[];
  getOpenWorkspaceKey: () => string | null;
}

const SidebarRowOrderContext = createContext<SidebarRowOrder | null>(null);

export function SidebarRowOrderProvider({
  orderedKeys,
  openWorkspaceKey,
  children,
}: {
  /** Every row the sidebar could show, top to bottom, whether or not it is mounted. */
  orderedKeys: readonly string[];
  openWorkspaceKey: string | null;
  children: ReactNode;
}) {
  const latestRef = useRef({ orderedKeys, openWorkspaceKey });
  useEffect(() => {
    latestRef.current = { orderedKeys, openWorkspaceKey };
  }, [orderedKeys, openWorkspaceKey]);
  const mountedRef = useRef(new Map<string, number>());

  const order = useMemo<SidebarRowOrder>(
    () => ({
      register: (workspaceKey) => {
        const mounted = mountedRef.current;
        mounted.set(workspaceKey, (mounted.get(workspaceKey) ?? 0) + 1);
        return () => {
          const count = (mounted.get(workspaceKey) ?? 1) - 1;
          if (count > 0) mounted.set(workspaceKey, count);
          else mounted.delete(workspaceKey);
        };
      },
      getVisibleKeys: () =>
        latestRef.current.orderedKeys.filter((key) => mountedRef.current.has(key)),
      getOpenWorkspaceKey: () => latestRef.current.openWorkspaceKey,
    }),
    [],
  );

  return (
    <SidebarRowOrderContext.Provider value={order}>{children}</SidebarRowOrderContext.Provider>
  );
}

function readRowPressModifiers(event: GestureResponderEvent): SidebarRowPressModifiers {
  if (!isWeb) return { toggle: false, shift: false };
  const nativeEvent = event.nativeEvent;
  const toggleKey = getShortcutOs() === "mac" ? "metaKey" : "ctrlKey";
  return {
    toggle: Reflect.get(nativeEvent, toggleKey) === true,
    shift: Reflect.get(nativeEvent, "shiftKey") === true,
  };
}

export interface SidebarRowSelection {
  /** Null while selection is off, so the row shows its usual leading visual. */
  checked: boolean | null;
  /** Ticks the row when the press is a selection press; answers whether it was. */
  handlePress: (event: GestureResponderEvent) => boolean;
  /** The row menu's "Select": turns selection on with this row ticked. */
  startSelecting: () => void;
}

export function useSidebarRowSelection(workspaceKey: string): SidebarRowSelection {
  const order = useContext(SidebarRowOrderContext);
  if (!order) {
    throw new Error("useSidebarRowSelection must be used inside SidebarRowOrderProvider");
  }
  const checked = useSidebarSelectionStore((state) =>
    state.selection.active ? state.selection.keys.has(workspaceKey) : null,
  );

  useEffect(() => order.register(workspaceKey), [order, workspaceKey]);

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      const store = useSidebarSelectionStore.getState();
      const intent = resolveSidebarRowPressIntent({
        selection: store.selection,
        modifiers: readRowPressModifiers(event),
      });
      if (intent === "open") return false;
      if (intent === "toggle") {
        store.toggle(workspaceKey);
      } else {
        store.selectRange({
          key: workspaceKey,
          visibleKeys: order.getVisibleKeys(),
          fallbackAnchorKey: order.getOpenWorkspaceKey(),
        });
      }
      return true;
    },
    [order, workspaceKey],
  );

  const startSelecting = useCallback(() => {
    useSidebarSelectionStore.getState().add(workspaceKey);
  }, [workspaceKey]);

  return useMemo(
    () => ({ checked, handlePress, startSelecting }),
    [checked, handlePress, startSelecting],
  );
}

/** Takes the row's leading slot while selection is on, so the title stays on its rail. */
export function SidebarSelectionCheckbox({
  checked,
  testID,
}: {
  checked: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.slot} testID={testID}>
      <View style={checked ? [styles.box, styles.boxChecked] : styles.box}>
        {checked ? <ThemedCheck uniProps={checkIconProps} strokeWidth={3} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Same box as the status dot and project icon slots it replaces.
  slot: {
    width: densityIconBox("md"),
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  box: {
    width: densityIconBox("sm"),
    height: densityIconBox("sm"),
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  boxChecked: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
}));
