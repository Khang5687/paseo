import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { EditorTargetIcon } from "@/components/icons/editor-target-icon";
import { SettingsRow } from "@/components/settings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { resolvePreferredEditorId, usePreferredEditor } from "@/hooks/use-preferred-editor";
import type { Theme } from "@/styles/theme";
import { useDesktopOpenTargets, type DesktopOpenTarget } from "@/workspace/desktop-open-targets";

const ThemedEditorTargetIcon = withUnistyles(EditorTargetIcon);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface DefaultEditorSetting {
  editors: DesktopOpenTarget[];
  selected: DesktopOpenTarget;
  select(editorId: string): void;
}

/**
 * The editor "Open in …" uses for workspaces and folders. Reads and writes the same
 * preference as the workspace button's "Choose editor" menu. Null while the desktop
 * reports no installed editors, so the row is hidden rather than empty.
 */
export function useDefaultEditorSetting(): DefaultEditorSetting | null {
  const { preferredEditorId, updatePreferredEditor } = usePreferredEditor();
  // Settings is not tied to a host; the options are the editors installed on this desktop.
  const { targets } = useDesktopOpenTargets({ isLocalExecution: true });
  const editors = useMemo(() => targets.filter((target) => target.kind === "editor"), [targets]);
  const selectedId = resolvePreferredEditorId(
    editors.map((editor) => editor.id),
    preferredEditorId,
  );
  const selected = editors.find((editor) => editor.id === selectedId) ?? null;
  const select = useCallback(
    (editorId: string) => {
      void updatePreferredEditor(editorId).catch(() => undefined);
    },
    [updatePreferredEditor],
  );
  return useMemo(
    () => (selected ? { editors, selected, select } : null),
    [editors, selected, select],
  );
}

function EditorIcon({ editor }: { editor: DesktopOpenTarget }) {
  return <ThemedEditorTargetIcon icon={editor.icon} size={16} uniProps={mutedColorMapping} />;
}

function EditorMenuItem({
  editor,
  selected,
  onSelect,
}: {
  editor: DesktopOpenTarget;
  selected: boolean;
  onSelect(editorId: string): void;
}) {
  const select = useCallback(() => onSelect(editor.id), [editor.id, onSelect]);
  const leading = useMemo(() => <EditorIcon editor={editor} />, [editor]);
  return (
    <DropdownMenuItem
      selected={selected}
      onSelect={select}
      leading={leading}
      testID={`settings-default-editor-item-${editor.id}`}
    >
      {editor.label}
    </DropdownMenuItem>
  );
}

export function DefaultEditorRow({ editors, selected, select }: DefaultEditorSetting) {
  const { t } = useTranslation();
  const label = t("settings.general.defaultEditor");
  const leading = useMemo(() => <EditorIcon editor={selected} />, [selected]);
  return (
    <SettingsRow label={label}>
      <DropdownMenu>
        <DropdownTrigger
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${selected.label}`}
          leading={leading}
          testID="settings-default-editor"
        >
          {selected.label}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={220}>
          {editors.map((editor) => (
            <EditorMenuItem
              key={editor.id}
              editor={editor}
              selected={editor.id === selected.id}
              onSelect={select}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}
