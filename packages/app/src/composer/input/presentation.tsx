import { useCallback, useMemo, type ReactNode, type Ref } from "react";
import { Text, View, type ViewProps } from "react-native";
import { Maximize2, Minimize2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ComposerFullscreenBody, ComposerFullscreenFooter } from "@/composer/dock";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { isWeb } from "@/constants/platform";
import {
  iconSizeFor,
  TOOLBAR_CONTROL_HEIGHT,
  TOOLBAR_CONTROL_SIZES,
  type ControlSizing,
} from "@/components/ui/control-geometry";
import { StyleSheet } from "react-native-unistyles";
import { useComposerFullscreenExit } from "./fullscreen-exit";
import { resolveGlyphRailOffset } from "./state";

function keepEditorFocused(event: import("react-native").PointerEvent) {
  if (isWeb) event.preventDefault();
}

/**
 * One tree for both layout modes. The editing surface and the attachment row keep their
 * positions so the mounted editor, its native buffer, selection, and focus survive every
 * toggle; only the chrome around them changes. Fullscreen puts a title bar with the exit
 * glyph on top, and moves the composer's own toolbar (attach, agent controls, voice, Send)
 * into a footer that rides the keyboard. A send error and the voice overlay sit in that
 * footer too, so the text stays readable while dictating.
 */
export function ComposerInputPresentation({
  fullscreen,
  title,
  controlSizing,
  surface,
  toolbar,
  error,
  onExit,
  inputWrapperRef,
  inputWrapperStyle,
  inputPointerEvents,
  attachmentSlot,
  showFullscreenButton,
  onEnter,
  overlay,
  resizeGrip,
}: {
  fullscreen: boolean;
  /** The fullscreen title bar's label: "Message" for chat. */
  title: string;
  /** The sizing the toolbar's stylesheet resolves to; see `resolveControlSizing`. */
  controlSizing: ControlSizing;
  surface: ReactNode;
  /** The composer's bottom bar, Send included. */
  toolbar: ReactNode;
  error: ReactNode;
  onExit: () => void;
  inputWrapperRef: Ref<View>;
  inputWrapperStyle: ViewProps["style"];
  inputPointerEvents: ViewProps["pointerEvents"];
  attachmentSlot: ReactNode;
  showFullscreenButton: boolean;
  onEnter: () => void;
  overlay: ReactNode;
  resizeGrip: ReactNode;
}) {
  const { t } = useTranslation();
  // A retained tab keeps its fullscreen editor mounted while hidden; the global exit
  // action (Escape, hardware back) belongs only to the pane the user is in.
  const { isActiveComposer } = useComposerKeyboardScope();
  const exitScopeRef = useComposerFullscreenExit(fullscreen && isActiveComposer, onExit);
  const glyphSize = iconSizeFor("md")[controlSizing];
  const railOffset = resolveGlyphRailOffset({
    controlSize: TOOLBAR_CONTROL_SIZES[controlSizing],
    glyphIconSize: glyphSize,
  });
  const maximizeIcon = useCallback(
    (color: string) => <Maximize2 color={color} size={glyphSize} />,
    [glyphSize],
  );
  const minimizeIcon = useCallback(
    (color: string) => <Minimize2 color={color} size={glyphSize} />,
    [glyphSize],
  );
  // Fullscreen controls share the text rail; the toolbar disc owns its separate corner inset.
  const enterStyle = useMemo(() => [styles.enterButton, { right: railOffset }], [railOffset]);
  const exitStyle = useMemo(() => [styles.iconButton, { marginRight: railOffset }], [railOffset]);
  return (
    // collapsable={false} here and on the input wrapper: the toggle adds or drops their
    // background, and a view Fabric flattens in one mode but not the other re-parents the
    // native editor, which blurs it and closes the Android keyboard.
    <View
      ref={exitScopeRef}
      collapsable={false}
      style={fullscreen ? styles.fullscreen : styles.inline}
      testID={fullscreen ? "composer-fullscreen" : undefined}
    >
      {fullscreen ? (
        <View style={styles.titleBar}>
          <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            accessibilityLabel={t("composer.input.exitFullscreen")}
            onPointerDown={keepEditorFocused}
            onPress={onExit}
            style={exitStyle}
            leftIcon={minimizeIcon}
            hitSlop={8}
          >
            {null}
          </Button>
        </View>
      ) : null}
      <ComposerFullscreenBody fullscreen={fullscreen}>
        <View
          ref={inputWrapperRef}
          collapsable={false}
          style={fullscreen ? styles.fullscreenInputWrapper : inputWrapperStyle}
          pointerEvents={inputPointerEvents}
        >
          {fullscreen ? null : resizeGrip}
          {attachmentSlot}
          <View style={fullscreen ? styles.fullscreenTextSurface : styles.inlineTextSurface}>
            {surface}
            {showFullscreenButton && !fullscreen ? (
              <Button
                variant="ghost"
                size="sm"
                accessibilityLabel={t("composer.input.fullscreen")}
                leftIcon={maximizeIcon}
                onPointerDown={keepEditorFocused}
                onPress={onEnter}
                style={enterStyle}
                hitSlop={8}
              >
                {null}
              </Button>
            ) : null}
          </View>
          {fullscreen ? null : toolbar}
        </View>
      </ComposerFullscreenBody>
      {fullscreen ? (
        <ComposerFullscreenFooter style={styles.footer}>
          {error}
          {/* The voice overlay covers only the bar, so the text stays in view while dictating. */}
          <View style={styles.toolbarSlot}>
            {toolbar}
            {overlay}
          </View>
        </ComposerFullscreenFooter>
      ) : (
        overlay
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inline: { flexShrink: 1, position: "relative" },
  inlineTextSurface: { flexShrink: 1, position: "relative" },
  iconButton: {
    width: TOOLBAR_CONTROL_HEIGHT,
    height: TOOLBAR_CONTROL_HEIGHT,
    padding: 0,
    borderWidth: 0,
    borderRadius: theme.borderRadius.full,
  },
  enterButton: {
    position: "absolute",
    top: 0,
    width: TOOLBAR_CONTROL_HEIGHT,
    height: TOOLBAR_CONTROL_HEIGHT,
    padding: 0,
    borderWidth: 0,
    borderRadius: theme.borderRadius.full,
  },
  fullscreen: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  fullscreenInputWrapper: { flex: 1, minHeight: 0, gap: theme.spacing[3] },
  fullscreenTextSurface: { flex: 1, minHeight: 0 },
  // Full-bleed: the rule under the title spans the screen, past the frame's padding.
  titleBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
    gap: theme.spacing[3],
    marginHorizontal: -theme.spacing[4],
    marginTop: -theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  // The send error rides the keyboard with the toolbar; below the body it would sit behind it.
  footer: { flexShrink: 0, gap: theme.spacing[3] },
  toolbarSlot: { position: "relative" },
}));
