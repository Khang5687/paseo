import { useCallback, useMemo, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useToast } from "@/contexts/toast-context";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  removeSkin,
  useSkinCatalog,
  useSkinPreferences,
  useSkinRenderState,
  type SkinSchemeTarget,
  type SkinSummary,
} from "@/skins";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { BackgroundControls } from "./background-controls";
import { SkinDetailsSheet } from "./skin-details-sheet";
import { AddImageCard, NoneCard, SkinCard } from "./skin-card";
import { SkinCatalogLinks } from "./skin-catalog-links";
import { SkinEditSheet } from "./skin-edit-sheet";
import { ADD_CARD_KEY, NONE_CARD_KEY, useBackgroundGallery } from "./use-background-gallery";
import { useEscapeKey } from "./use-escape-key";

const DESKTOP_CARD_WIDTH = 160;
const COMPACT_COLUMNS = 2;
const GRID_GAP = 12;

function useStatusText(): string | null {
  const { t } = useTranslation();
  const { state, error } = useSkinRenderState();
  if (state === "reduced-transparency") {
    return t("settings.appearance.background.status.reducedTransparency");
  }
  if (state === "forced-colors") {
    return t("settings.appearance.background.status.forcedColors");
  }
  if (state === "error") {
    return error ?? t("settings.appearance.background.status.error");
  }
  return null;
}

export function BackgroundSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const catalog = useSkinCatalog();
  const preferences = useSkinPreferences();
  const statusText = useStatusText();
  const gallery = useBackgroundGallery();
  const { target, setTarget, pendingKey, endPreview, commit } = gallery;

  const [gridWidth, setGridWidth] = useState(0);
  const [editing, setEditing] = useState<SkinSummary | null>(null);
  const [details, setDetails] = useState<SkinSummary | null>(null);

  const hasSelection = preferences.selection.light !== null || preferences.selection.dark !== null;

  useEscapeKey(gallery.previewActive, endPreview);

  const targetOptions = useMemo<SegmentedControlOption<SkinSchemeTarget>[]>(
    () => [
      {
        value: "both",
        label: t("settings.appearance.background.applyTo.options.both"),
      },
      {
        value: "light",
        label: t("settings.appearance.background.applyTo.options.light"),
      },
      {
        value: "dark",
        label: t("settings.appearance.background.applyTo.options.dark"),
      },
    ],
    [t],
  );

  const handleGridLayout = useCallback((event: LayoutChangeEvent) => {
    setGridWidth(event.nativeEvent.layout.width);
  }, []);

  // Compact layouts show two columns; wider ones use a fixed card width and wrap.
  const cardStyle = useMemo(() => {
    if (!isCompact) return { width: DESKTOP_CARD_WIDTH };
    const width = Math.floor((gridWidth - GRID_GAP * (COMPACT_COLUMNS - 1)) / COMPACT_COLUMNS);
    return width > 0 ? { width } : { width: "48%" as const };
  }, [gridWidth, isCompact]);

  const handleNone = useCallback(() => commit(null), [commit]);
  const handleEdit = useCallback((skin: SkinSummary) => setEditing(skin), []);
  const handleDetails = useCallback((skin: SkinSummary) => setDetails(skin), []);
  const handleCloseEdit = useCallback(() => setEditing(null), []);
  const handleCloseDetails = useCallback(() => setDetails(null), []);

  const handleDelete = useCallback(
    (skin: SkinSummary) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("settings.appearance.background.delete.title", {
            name: skin.name,
          }),
          message: t("settings.appearance.background.delete.message"),
          confirmLabel: t("settings.appearance.background.delete.confirm"),
          destructive: true,
        });
        if (!confirmed) return;
        try {
          await removeSkin(skin.id);
        } catch (error) {
          const message = error instanceof Error && error.message ? error.message : String(error);
          toast.error(t("settings.appearance.background.errors.remove", { message }));
        }
      })();
    },
    [t, toast],
  );

  const undoLabel = t("settings.appearance.background.undo.accessibilityLabel");
  const undoText = t("settings.appearance.background.undo.action");
  const undoButton = useMemo(
    () =>
      gallery.canUndo ? (
        <Button
          variant="ghost"
          size="xs"
          onPress={gallery.undo}
          accessibilityLabel={undoLabel}
          testID="settings-background-undo"
        >
          {undoText}
        </Button>
      ) : undefined,
    [gallery.canUndo, gallery.undo, undoLabel, undoText],
  );

  return (
    <SettingsSection title={t("settings.appearance.background.title")} trailing={undoButton}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.appearance.background.applyTo.title")}
            </Text>
          </View>
          <SegmentedControl
            size="sm"
            options={targetOptions}
            value={target}
            onValueChange={setTarget}
            testID="settings-background-target"
          />
        </View>
        <View
          style={[settingsStyles.rowBorder, styles.gridPadding]}
          onPointerLeave={endPreview}
          accessibilityLabel={t("settings.appearance.background.gallery.accessibilityLabel")}
        >
          <View style={styles.grid} onLayout={handleGridLayout}>
            <NoneCard
              selected={gallery.isSelected(null)}
              pending={pendingKey === NONE_CARD_KEY}
              onPress={handleNone}
              onPreviewCancel={endPreview}
              style={cardStyle}
            />
            {catalog.map((skin) => (
              <SkinCard
                key={skin.id}
                skin={skin}
                selected={gallery.isSelected(skin.id)}
                pending={pendingKey === skin.id}
                onCommit={commit}
                onPreviewIntent={gallery.schedulePreview}
                onPreviewCancel={gallery.cancelPreview}
                onPreviewEnd={endPreview}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onDetails={handleDetails}
                style={cardStyle}
              />
            ))}
            <AddImageCard
              pending={pendingKey === ADD_CARD_KEY}
              onPress={gallery.addImage}
              onPreviewCancel={endPreview}
              style={cardStyle}
            />
          </View>
        </View>
        <SkinCatalogLinks />
      </View>
      {statusText ? (
        <Text style={styles.status} testID="settings-background-status">
          {statusText}
        </Text>
      ) : null}
      {hasSelection ? <BackgroundControls /> : null}
      <SkinEditSheet skin={editing} onClose={handleCloseEdit} />
      <SkinDetailsSheet skin={details} onClose={handleCloseDetails} />
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  gridPadding: {
    padding: theme.spacing[4],
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: GRID_GAP,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
}));
