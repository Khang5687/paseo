import { useCallback, useMemo, type ReactElement } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { History } from "lucide-react-native";
import type { AgentDraftSnapshotSummary } from "@getpaseo/protocol/messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MenuTriggerState } from "@/components/ui/menu";
import type { Theme } from "@/styles/theme";
import { formatTimeAgo } from "@/utils/time";
import { composerPillStyles } from "../pill-styles";

export interface DraftHistoryControlProps {
  history: AgentDraftSnapshotSummary[];
  onRestore: (snapshotId: string) => void;
  disabled?: boolean;
}

const ThemedHistory = withUnistyles(History);
const iconMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function DraftHistoryControl({
  history,
  onRestore,
  disabled = false,
}: DraftHistoryControlProps): ReactElement | null {
  const { t } = useTranslation();
  const entries = useMemo(() => [...history].sort((a, b) => b.createdAt - a.createdAt), [history]);
  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => [
      composerPillStyles.body,
      styles.trigger,
      (hovered || pressed || open) && composerPillStyles.bodyActive,
    ],
    [],
  );

  if (entries.length === 0) return null;

  const label = t("composer.draftHistory.restore");
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="draft-history-trigger"
        style={triggerStyle}
      >
        <ThemedHistory size={14} uniProps={iconMutedMapping} />
        <Text style={composerPillStyles.label} numberOfLines={1}>
          {label}
        </Text>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        offset={8}
        minWidth={260}
        maxWidth={360}
        testID="draft-history-menu"
        sheetTitle={label}
      >
        {entries.map((entry, index) => (
          <DraftHistoryItem key={entry.id} entry={entry} index={index} onRestore={onRestore} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DraftHistoryItem({
  entry,
  index,
  onRestore,
}: {
  entry: AgentDraftSnapshotSummary;
  index: number;
  onRestore: (snapshotId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onRestore(entry.id), [entry.id, onRestore]);
  const preview = entry.preview.trim() || t("composer.draftHistory.attachmentsOnly");
  const timeAgo = formatTimeAgo(new Date(entry.createdAt));
  const description =
    entry.attachmentCount > 0
      ? `${timeAgo} · ${t("composer.draftHistory.attachments", { count: entry.attachmentCount })}`
      : timeAgo;
  return (
    <DropdownMenuItem
      testID={`draft-history-item-${index}`}
      description={description}
      onSelect={handleSelect}
    >
      {preview}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    alignSelf: "flex-start",
    gap: theme.spacing[1],
  },
}));
