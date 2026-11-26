import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet as NativeStyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { updateLocalSkin, useSkinThumbnail, type SkinFocal, type SkinSummary } from "@/skins";
import { focalFromPoint } from "./selection";

// expo-image on web reads only plain style objects; a Unistyles style reaches it without its
// layout, so the preview keeps a static React Native style.
const previewImageStyle = NativeStyleSheet.absoluteFill;

const MAX_FRAME_HEIGHT = 280;
const DEFAULT_ASPECT = 16 / 9;
const MARKER_SIZE = 20;
const MAX_NAME_LENGTH = 60;

interface FrameSize {
  width: number;
  height: number;
}

interface SkinEditBodyProps {
  skin: SkinSummary;
  onClose: () => void;
}

function SkinEditBody({ skin, onClose }: SkinEditBodyProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const thumbnail = useSkinThumbnail(skin.id);
  const [name, setName] = useState(skin.name);
  const [focal, setFocal] = useState<SkinFocal>(skin.focal);
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [isSaving, setIsSaving] = useState(false);

  const frameSize = useMemo<FrameSize>(() => {
    const width = Math.min(availableWidth, MAX_FRAME_HEIGHT * aspect);
    return { width, height: aspect > 0 ? width / aspect : 0 };
  }, [availableWidth, aspect]);

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailableWidth(event.nativeEvent.layout.width);
  }, []);

  const handleImageLoad = useCallback((event: { source: { width: number; height: number } }) => {
    const { width, height } = event.source;
    if (width > 0 && height > 0) {
      setAspect(width / height);
    }
  }, []);

  const handleFramePress = useCallback(
    (event: GestureResponderEvent) => {
      const { locationX, locationY } = event.nativeEvent;
      setFocal(focalFromPoint({ x: locationX, y: locationY }, frameSize));
    },
    [frameSize],
  );

  const trimmedName = name.trim();
  const canSave = !isSaving && trimmedName.length > 0;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      await updateLocalSkin(skin.id, { name: trimmedName, focal });
      onClose();
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error);
      toast.error(t("settings.appearance.background.errors.update", { message }));
      setIsSaving(false);
    }
  }, [canSave, focal, onClose, skin.id, t, toast, trimmedName]);

  const handleSaveVoid = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  const frameStyle = useMemo(
    () => [styles.frame, { width: frameSize.width, height: frameSize.height }],
    [frameSize.height, frameSize.width],
  );
  const markerStyle = useMemo(
    () => [
      styles.marker,
      {
        left: focal.x * frameSize.width - MARKER_SIZE / 2,
        top: focal.y * frameSize.height - MARKER_SIZE / 2,
      },
    ],
    [focal.x, focal.y, frameSize.height, frameSize.width],
  );
  const imageSource = useMemo(() => (thumbnail ? { uri: thumbnail } : null), [thumbnail]);

  return (
    <View style={styles.body}>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{t("settings.appearance.background.edit.name")}</Text>
        <AdaptiveTextInput
          initialValue={skin.name}
          onChangeText={setName}
          maxLength={MAX_NAME_LENGTH}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          onSubmitEditing={handleSaveVoid}
          style={styles.input}
          testID="settings-background-edit-name"
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{t("settings.appearance.background.edit.focal")}</Text>
        <Text style={styles.fieldHint}>{t("settings.appearance.background.edit.focalHint")}</Text>
        <View style={styles.frameContainer} onLayout={handleContainerLayout}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("settings.appearance.background.edit.focalAccessibility")}
            onPress={handleFramePress}
            style={frameStyle}
            testID="settings-background-edit-focal"
          >
            {imageSource ? (
              <View style={styles.image} pointerEvents="none">
                <Image
                  source={imageSource}
                  contentFit="fill"
                  style={previewImageStyle}
                  onLoad={handleImageLoad}
                  accessibilityIgnoresInvertColors
                />
              </View>
            ) : null}
            <View style={markerStyle} pointerEvents="none">
              <View style={styles.markerDot} />
            </View>
          </Pressable>
        </View>
      </View>
      <View style={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          style={styles.actionButton}
          onPress={onClose}
          disabled={isSaving}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          style={styles.actionButton}
          onPress={handleSaveVoid}
          disabled={!canSave}
          testID="settings-background-edit-save"
        >
          {isSaving
            ? t("settings.appearance.background.edit.saving")
            : t("settings.appearance.background.edit.save")}
        </Button>
      </View>
    </View>
  );
}

interface SkinEditSheetProps {
  skin: SkinSummary | null;
  onClose: () => void;
}

export function SkinEditSheet({ skin, onClose }: SkinEditSheetProps) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.appearance.background.edit.title") }),
    [t],
  );
  return (
    <AdaptiveModalSheet
      visible={skin !== null}
      onClose={onClose}
      header={header}
      testID="settings-background-edit-sheet"
    >
      {skin ? <SkinEditBody key={skin.id} skin={skin} onClose={onClose} /> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  field: {
    gap: theme.spacing[2],
  },
  fieldLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  fieldHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  input: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  frameContainer: {
    alignItems: "center",
  },
  frame: {
    borderRadius: theme.borderRadius.md,
    borderWidth: 0,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  image: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  marker: {
    position: "absolute",
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: MARKER_SIZE / 2,
    borderWidth: 2,
    borderColor: "#ffffff",
    backgroundColor: "rgba(0, 0, 0, 0.35)",
  },
  markerDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#ffffff",
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));
