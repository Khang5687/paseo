import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { type FieldControlSize } from "@/components/ui/control-geometry";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { settingsStyles } from "@/styles/settings";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";

/**
 * Feature defaults apply to every new agent, so the feature catalog is probed in the
 * daemon's home directory rather than a workspace, as agent profiles do.
 */
export const FEATURE_DEFAULTS_CWD = "~";
/** Select value meaning "no Paseo default": the provider's own settings decide. */
const PROVIDER_DEFAULT_VALUE = "";
const PROVIDER_DEFAULT_OPTION_ID = "__provider_default__";

function toFeatureDefaultKey(feature: AgentFeature, stored: boolean | string | undefined): string {
  if (feature.type === "toggle") {
    return typeof stored === "boolean" ? String(stored) : PROVIDER_DEFAULT_VALUE;
  }
  return typeof stored === "string" ? stored : PROVIDER_DEFAULT_VALUE;
}

function fromFeatureDefaultKey(feature: AgentFeature, key: string): boolean | string | null {
  if (key === PROVIDER_DEFAULT_VALUE) {
    return null;
  }
  if (feature.type === "toggle") {
    return key === "true";
  }
  return key;
}

/** One settings row that picks a feature's default value; `null` clears it. */
export function FeatureDefaultRow({
  feature,
  stored,
  isFirst,
  disabled,
  size,
  title,
  hint,
  testIDPrefix = "provider-feature-default",
  onChange,
}: {
  feature: AgentFeature;
  stored: boolean | string | undefined;
  isFirst: boolean;
  disabled: boolean;
  size: FieldControlSize;
  /** Row title; the feature's label when absent. */
  title?: string;
  /** Row hint; the feature's description when absent. */
  hint?: string;
  testIDPrefix?: string;
  onChange: (feature: AgentFeature, value: boolean | string | null) => void;
}) {
  const { t } = useTranslation();
  const rowStyle = useMemo(
    () => [settingsStyles.row, isFirst ? null : settingsStyles.rowBorder],
    [isFirst],
  );
  const value = toFeatureDefaultKey(feature, stored);
  const options = useMemo<SelectFieldOption<string>[]>(() => {
    const providerDefault: SelectFieldOption<string> = {
      id: PROVIDER_DEFAULT_OPTION_ID,
      value: PROVIDER_DEFAULT_VALUE,
      label: t("settings.providers.featureDefaults.providerDefault"),
      testID: `${testIDPrefix}-option-${feature.id}-default`,
    };
    if (feature.type === "toggle") {
      return [
        providerDefault,
        {
          id: "true",
          value: "true",
          label: t("settings.providers.featureDefaults.on"),
          testID: `${testIDPrefix}-option-${feature.id}-on`,
        },
        {
          id: "false",
          value: "false",
          label: t("settings.providers.featureDefaults.off"),
          testID: `${testIDPrefix}-option-${feature.id}-off`,
        },
      ];
    }
    return [
      providerDefault,
      ...feature.options.map((option) => ({
        id: option.id,
        value: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        testID: `${testIDPrefix}-option-${feature.id}-${option.id}`,
      })),
    ];
  }, [feature, t, testIDPrefix]);
  // A stored value the provider no longer offers still shows, so the user can clear it.
  const selectedDisplay = useMemo<SelectFieldDisplay>(() => {
    const option = options.find((candidate) => candidate.value === value);
    return { label: option?.label ?? value };
  }, [options, value]);
  const handleChange = useCallback(
    (key: string) => onChange(feature, fromFeatureDefaultKey(feature, key)),
    [feature, onChange],
  );
  const rowTitle = title ?? feature.label;
  const rowHint = hint ?? feature.description;

  return (
    <View style={rowStyle} testID={`${testIDPrefix}-row-${feature.id}`}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {rowTitle}
        </Text>
        {rowHint ? (
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {rowHint}
          </Text>
        ) : null}
      </View>
      <View style={styles.picker}>
        <SelectField
          field={false}
          label={rowTitle}
          value={value}
          selectedDisplay={selectedDisplay}
          options={options}
          onChange={handleChange}
          placeholder={rowTitle}
          emptyText={rowTitle}
          disabled={disabled}
          searchable={options.length > 6}
          title={rowTitle}
          size={size}
          triggerTestID={`${testIDPrefix}-trigger-${feature.id}`}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  picker: {
    width: 200,
    flexShrink: 0,
  },
});
