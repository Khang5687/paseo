import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { useAppSettings, type SendShortcut, type SendBehavior } from "@/hooks/use-settings";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import { getShortcutOs } from "@/utils/shortcut-platform";

const SEND_BEHAVIORS: readonly SendBehavior[] = ["interrupt", "steer", "queue"];

function defaultSendHintKey(
  shortcutsAvailable: boolean,
  sendShortcut: SendShortcut,
  behavior: SendBehavior,
) {
  if (!shortcutsAvailable)
    return `settings.general.defaultSend.touchDescriptions.${behavior}` as const;
  if (sendShortcut === "mod-enter") {
    return `settings.general.defaultSend.commandEnterDescriptions.${behavior}` as const;
  }
  return `settings.general.defaultSend.descriptions.${behavior}` as const;
}

// Without a keyboard, or while Enter inserts a new line, only the long-press reaches the alternate.
function alternateSendHintKey(
  shortcutsAvailable: boolean,
  sendShortcut: SendShortcut,
  behavior: SendBehavior,
) {
  if (shortcutsAvailable && sendShortcut === "enter") {
    return `settings.general.alternateSend.descriptions.${behavior}` as const;
  }
  return `settings.general.alternateSend.longPressDescriptions.${behavior}` as const;
}

export function SendingSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  const modifier = getShortcutOs() === "mac" ? "⌘" : "Ctrl";
  const options = useMemo(
    () =>
      SEND_BEHAVIORS.map((value) => ({
        value,
        label: t(`settings.general.defaultSend.options.${value}`),
      })),
    [t],
  );
  const change = useCallback(
    (sendBehavior: SendBehavior) => void updateSettings({ sendBehavior }),
    [updateSettings],
  );
  const changeAlternate = useCallback(
    (alternateSendBehavior: SendBehavior) => void updateSettings({ alternateSendBehavior }),
    [updateSettings],
  );
  const shortcutOptions = useMemo(
    () =>
      (["enter", "mod-enter"] as const).map((value) => ({
        value,
        label: t(`settings.general.sendShortcut.options.${value}`, { modifier }),
      })),
    [t, modifier],
  );
  const changeSendShortcut = useCallback(
    (sendShortcut: SendShortcut) => void updateSettings({ sendShortcut }),
    [updateSettings],
  );
  const { sendShortcut, sendBehavior, alternateSendBehavior } = settings;
  return (
    <SettingsSection title={t("settings.general.sending")}>
      <SettingsCard>
        {shortcutsAvailable ? (
          <SettingsSelect
            label={t("settings.general.sendShortcut.label")}
            value={settings.sendShortcut}
            options={shortcutOptions}
            onValueChange={changeSendShortcut}
          />
        ) : null}
        <SettingsSelect
          label={t("settings.general.defaultSend.label")}
          hint={t(defaultSendHintKey(shortcutsAvailable, sendShortcut, sendBehavior), {
            modifier,
          })}
          value={settings.sendBehavior}
          options={options}
          onValueChange={change}
        />
        <SettingsSelect
          label={t("settings.general.alternateSend.label")}
          hint={t(alternateSendHintKey(shortcutsAvailable, sendShortcut, alternateSendBehavior), {
            modifier,
          })}
          value={settings.alternateSendBehavior}
          options={options}
          onValueChange={changeAlternate}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
