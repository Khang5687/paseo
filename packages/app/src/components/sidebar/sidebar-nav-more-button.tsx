import type { PluginBadge } from "@getpaseo/plugin/client";
import { Ellipsis } from "lucide-react-native";
import { useMemo, useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { SidebarBadge } from "@/components/sidebar/sidebar-badge";
import { DensityIcon } from "@/components/ui/density-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIconButtonChromeStyle } from "@/components/ui/icon-button-chrome";
import type { IconRowOverflowEntry, IconRowOverflowStore } from "@/sidebar-nav/icon-row-overflow";
import { PLUGIN_SIDEBAR_NAV_ICON } from "@/sidebar-nav/item-presentation";

const TEST_ID = "sidebar-nav-more";

/**
 * The phone icon row's last button when some buttons do not fit: a sheet listing them by name.
 * A badge on a button inside it shows as a dot on More, red when any of them is red.
 */
export function SidebarNavMoreButton({
  store,
}: {
  store: IconRowOverflowStore;
}): ReactElement | null {
  const { t } = useTranslation();
  const entries = useSyncExternalStore(store.subscribe, store.getEntries);
  const chromeStyle = useIconButtonChromeStyle({ size: "large", round: true });
  const badge = useMemo<PluginBadge | null>(() => {
    const tones = entries.flatMap((entry) => (entry.badge ? [entry.badge.tone] : []));
    if (tones.length === 0) return null;
    return { tone: tones.includes("attention") ? "attention" : "warning" };
  }, [entries]);
  if (entries.length === 0) return null;
  const label = t("sidebar.navButtons.more");
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        style={chromeStyle}
        testID={TEST_ID}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <DensityIcon icon={Ellipsis} size="md" color="foregroundMuted" />
        <SidebarBadge badge={badge} placement="corner" ownerTestID={TEST_ID} />
      </DropdownMenuTrigger>
      <DropdownMenuContent sheetTitle={label} align="end" width={240} testID={`${TEST_ID}-menu`}>
        {entries.map((entry) => (
          <SidebarNavMoreItem key={entry.key} entry={entry} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarNavMoreItem({ entry }: { entry: IconRowOverflowEntry }): ReactElement {
  const leading = useMemo(
    () => (
      <DensityIcon icon={entry.icon ?? PLUGIN_SIDEBAR_NAV_ICON} size="sm" color="foregroundMuted" />
    ),
    [entry.icon],
  );
  const trailing = useMemo(
    () =>
      entry.badge ? (
        <SidebarBadge
          badge={entry.badge}
          placement="inline"
          ownerTestID={entry.testID ? `${TEST_ID}-item-${entry.testID}` : undefined}
        />
      ) : null,
    [entry.badge, entry.testID],
  );
  return (
    <DropdownMenuItem
      leading={leading}
      trailing={trailing}
      onSelect={entry.press}
      testID={entry.testID ? `${TEST_ID}-item-${entry.testID}` : undefined}
    >
      {entry.label}
    </DropdownMenuItem>
  );
}
