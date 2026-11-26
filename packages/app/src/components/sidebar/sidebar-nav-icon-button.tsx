import { createContext, useCallback, useContext, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  useContextMenu,
} from "@/components/ui/context-menu";
import { DensityIcon } from "@/components/ui/density-icon";
import { useIconButtonChromeStyle } from "@/components/ui/icon-button-chrome";
import { MenuCheckboxItem, MenuSubTrigger, type MenuPageDefinition } from "@/components/ui/menu";
import { isWeb } from "@/constants/platform";
import {
  PLUGIN_SIDEBAR_NAV_ICON,
  sidebarNavItemIcon,
  sidebarNavItemLabel,
  type SidebarNavIconComponent,
} from "@/sidebar-nav/item-presentation";
import type { SidebarNavItem } from "@/sidebar-nav/model";

export interface SidebarNavIconRowValue {
  /** Every header item, hidden ones included, in display order. */
  items: readonly SidebarNavItem[];
  setVisible: (key: string, visible: boolean) => void;
}

/**
 * Set by the phone's icon row. A sidebar header row (built-in, plugin kit row or legacy plugin
 * row) that renders inside it draws itself as a round icon button instead of a full-width row.
 */
export const SidebarNavIconRowContext = createContext<SidebarNavIconRowValue | null>(null);

export function useSidebarNavIconRow(): SidebarNavIconRowValue | null {
  return useContext(SidebarNavIconRowContext);
}

const BUTTONS_PAGE_ID = "buttons";

interface SidebarNavIconButtonProps {
  icon: SidebarNavIconComponent | null;
  label: string;
  onPress: () => void;
  isActive: boolean;
  testID?: string;
  nativeID?: string;
  accessibilityLabel?: string;
  row: SidebarNavIconRowValue;
}

/**
 * One button of the phone's icon row. Tap does what the row did. Long press opens a sheet titled
 * with the button's name, whose one row leads to "Buttons to show".
 */
export function SidebarNavIconButton({ row, ...props }: SidebarNavIconButtonProps): ReactElement {
  return (
    <ContextMenu>
      <SidebarNavIconTrigger {...props} />
      <SidebarNavButtonsMenu label={props.label} testID={props.testID} row={row} />
    </ContextMenu>
  );
}

function SidebarNavIconTrigger({
  icon,
  label,
  onPress,
  isActive,
  testID,
  nativeID,
  accessibilityLabel,
}: Omit<SidebarNavIconButtonProps, "row">): ReactElement {
  const menu = useContextMenu();
  const chromeStyle = useIconButtonChromeStyle({ size: "large", round: true, active: isActive });
  // ContextMenuTrigger opens on right click on web and on long press natively. A phone browser
  // gets no right click, so the web trigger opens on long press as well.
  const { setOpen } = menu;
  const handleWebLongPress = useCallback(() => setOpen(true), [setOpen]);
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  return (
    <ContextMenuTrigger
      onPress={onPress}
      onLongPress={isWeb ? handleWebLongPress : undefined}
      style={chromeStyle}
      testID={testID}
      nativeID={nativeID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={accessibilityState}
      aria-selected={isActive}
    >
      <DensityIcon
        icon={icon ?? PLUGIN_SIDEBAR_NAV_ICON}
        size="md"
        color={isActive ? "foreground" : "foregroundMuted"}
      />
    </ContextMenuTrigger>
  );
}

function SidebarNavButtonsMenu({
  label,
  testID,
  row,
}: {
  label: string;
  testID?: string;
  row: SidebarNavIconRowValue;
}): ReactElement {
  const { t } = useTranslation();
  const title = t("sidebar.navButtons.title");
  // Page content renders through the sheet's portal, so it takes what it needs as props.
  const pages = useMemo<MenuPageDefinition[]>(
    () => [
      {
        id: BUTTONS_PAGE_ID,
        title,
        content: <SidebarNavButtonsList items={row.items} setVisible={row.setVisible} />,
      },
    ],
    [row.items, row.setVisible, title],
  );
  return (
    <ContextMenuContent
      sheetTitle={label}
      pages={pages}
      align="start"
      width={240}
      testID={testID ? `${testID}-menu` : undefined}
    >
      <MenuSubTrigger id={BUTTONS_PAGE_ID} testID="sidebar-nav-buttons-open">
        {title}
      </MenuSubTrigger>
    </ContextMenuContent>
  );
}

function SidebarNavButtonsList({ items, setVisible }: SidebarNavIconRowValue): ReactElement {
  const { t } = useTranslation();
  const visibleCount = items.filter((item) => item.visible).length;
  return (
    <>
      {items.map((item) => (
        <SidebarNavButtonsListItem
          key={item.key}
          item={item}
          label={sidebarNavItemLabel(t, item)}
          // The last button left stays, so the row keeps something to long-press.
          disabled={item.visible && visibleCount === 1}
          setVisible={setVisible}
        />
      ))}
      <ContextMenuItem testID="sidebar-nav-buttons-done">
        {t("sidebar.navButtons.done")}
      </ContextMenuItem>
    </>
  );
}

function SidebarNavButtonsListItem({
  item,
  label,
  disabled,
  setVisible,
}: {
  item: SidebarNavItem;
  label: string;
  disabled: boolean;
  setVisible: (key: string, visible: boolean) => void;
}): ReactElement {
  const handleToggle = useCallback(
    () => setVisible(item.key, !item.visible),
    [item.key, item.visible, setVisible],
  );
  const leading = useMemo(
    () => <DensityIcon icon={sidebarNavItemIcon(item)} size="sm" color="foregroundMuted" />,
    [item],
  );
  return (
    <MenuCheckboxItem
      checked={item.visible}
      onToggle={handleToggle}
      disabled={disabled}
      leading={leading}
      testID={`sidebar-nav-buttons-item-${item.key}`}
    >
      {label}
    </MenuCheckboxItem>
  );
}
