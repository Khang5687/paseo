import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { Archive, Copy } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { renderTriggerIcon, triggerStyle } from "@/components/sidebar/sidebar-workspace-menu";
import type { Theme } from "@/styles/theme";

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const ThemedCopy = withUnistyles(Copy);
const ThemedArchive = withUnistyles(Archive);
const copyLeadingIcon = <ThemedCopy size={14} uniProps={foregroundMutedColorMapping} />;
const archiveLeadingIcon = <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />;

/**
 * Kebab menu on a subagent row inside a thread: the touch path to Archive and Copy agent ID, since
 * the row has no hover-only icons on a phone. Archive confirms before it runs.
 */
export function SidebarThreadChildMenu({
  agentId,
  onCopyAgentId,
  onArchive,
  open,
  onOpenChange,
}: {
  agentId: string;
  onCopyAgentId: () => void;
  onArchive: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.workspace.actions.menu")}
        testID={`sidebar-thread-child-kebab-${agentId}`}
      >
        {renderTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={260} sheetTitle={t("sidebar.workspace.actions.menu")}>
        <DropdownMenuItem
          testID={`sidebar-thread-child-menu-copy-agent-id-${agentId}`}
          leading={copyLeadingIcon}
          onSelect={onCopyAgentId}
        >
          {t("sidebar.workspace.actions.copyAgentId")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID={`sidebar-thread-child-menu-archive-${agentId}`}
          leading={archiveLeadingIcon}
          onSelect={onArchive}
        >
          {t("sidebar.workspace.actions.archive")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
