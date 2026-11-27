import { useCallback, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, Paperclip } from "lucide-react-native";
import { AttachmentPillSizeProvider } from "@/components/attachment-pill";
import { MenuRoot, MenuSurface, MenuTrigger, type MenuTriggerState } from "@/components/ui/menu";
import type { Theme } from "@/styles/theme";

/** Past this many attachments, the phone tray folds its tiles into one chip. */
export const ATTACHMENT_TILE_LIMIT = 4;

/**
 * How the composer's attachment tray draws.
 * - `cards`: the labelled cards, wrapping onto as many lines as they need. Wide layouts.
 * - `tiles`: one row of small tiles, each with its own ×. The phone, up to the tile limit.
 * - `chip`: one "N files" chip whose panel lists the cards. The phone, past the tile limit.
 *
 * The phone is the compact form factor whether or not the keyboard is up: the tray must not
 * resize under the user's thumb when the keyboard opens or closes.
 */
export type AttachmentTrayLayout = "cards" | "tiles" | "chip";

export function resolveAttachmentTrayLayout(input: {
  compact: boolean;
  count: number;
}): AttachmentTrayLayout {
  if (!input.compact) return "cards";
  return input.count > ATTACHMENT_TILE_LIMIT ? "chip" : "tiles";
}

const ThemedPaperclip = withUnistyles(Paperclip);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The attachment tray inside the composer input. `children` are the attachment pills. */
export function AttachmentTray({
  layout,
  count,
  children,
}: {
  layout: AttachmentTrayLayout;
  count: number;
  children: ReactNode;
}): ReactElement {
  if (layout === "tiles") {
    return (
      <AttachmentPillSizeProvider value="tile">
        <View style={styles.tiles} testID="composer-attachment-tray">
          {children}
        </View>
      </AttachmentPillSizeProvider>
    );
  }
  if (layout === "chip") {
    return <AttachmentTrayChip count={count}>{children}</AttachmentTrayChip>;
  }
  return (
    <View style={styles.cards} testID="composer-attachment-tray">
      {children}
    </View>
  );
}

/**
 * A popover, not a sheet, on the phone too: the keyboard is usually up while the user trims the
 * list, and a popover above the chip leaves the text they are writing in view.
 */
function AttachmentTrayChip({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const label = t("composer.attachments.trayChip", { count });
  const chipStyle = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => [
      styles.chip,
      (hovered || pressed || open) && styles.chipActive,
    ],
    [],
  );
  return (
    <View style={styles.chipRow} testID="composer-attachment-tray">
      <MenuRoot>
        <MenuTrigger
          testID="composer-attachment-tray-chip"
          accessibilityRole="button"
          accessibilityLabel={label}
          style={chipStyle}
        >
          <ThemedPaperclip size={14} uniProps={mutedIconMapping} />
          <Text style={styles.chipLabel} numberOfLines={1}>
            {label}
          </Text>
          <ThemedChevronDown size={14} uniProps={mutedIconMapping} />
        </MenuTrigger>
        <MenuSurface
          side="top"
          align="start"
          offset={8}
          maxWidth={360}
          maxHeight={320}
          scrollable
          testID="composer-attachment-tray-panel"
        >
          <View style={styles.panelCards}>{children}</View>
        </MenuSurface>
      </MenuRoot>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  cards: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  // Room above for the tiles' × buttons, which hang over the top-right corner.
  tiles: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingTop: theme.spacing[1],
  },
  chipRow: {
    flexDirection: "row",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    height: 28,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  chipActive: {
    backgroundColor: theme.colors.surface2,
  },
  chipLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  // The cards' × buttons hang 8px off their top-left corner.
  panelCards: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
}));
