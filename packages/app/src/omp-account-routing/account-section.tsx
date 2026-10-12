import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowDown, ArrowUp } from "lucide-react-native";
import type {
  OmpAccountRoutingMutation,
  OmpAccountRoutingState,
  OmpRoutingAccountRef,
} from "@getpaseo/protocol/messages";
import { SettingsCard, SettingsRow, SettingsSwitch } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  buildAccountRows,
  buildWindowViews,
  accountRefusal,
  describeAccount,
  buildNotices,
  describeSection,
  formatTimestamp,
  refKey,
  type AccountRow,
  type ServingRequest,
  type WindowView,
} from "./presentation";
import { useHostAccountRouting } from "./queries";

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColor} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColor} />;

type Mutate = (command: OmpAccountRoutingMutation) => void;

function ServingLine({
  serverId,
  request,
  account,
}: {
  serverId: string;
  request: ServingRequest;
  account: string;
}) {
  const { t } = useTranslation();
  const title = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(request.agentId)?.title,
  );
  return (
    <Text style={settingsStyles.rowHint}>
      {t("ompAccountRouting.values.serving", {
        account,
        agent: title ?? t("workspace.tabs.fallback.agent"),
      })}
    </Text>
  );
}

function WindowLine({ view, locale }: { view: WindowView; locale: string }) {
  const { t } = useTranslation();
  let name: string;
  if (view.kind === "fiveHour") name = t("ompAccountRouting.labels.fiveHour");
  else if (view.kind === "weekly") name = t("ompAccountRouting.labels.weekly");
  else if (view.kind === "model") {
    name = `${t("ompAccountRouting.labels.modelWindow")} · ${view.serverLabel}`;
  } else name = view.serverLabel;

  const parts: string[] = [];
  if (view.consumedPct !== null && view.remainingPct !== null) {
    parts.push(
      t("ompAccountRouting.values.consumed", { percent: view.consumedPct }),
      t("ompAccountRouting.values.remaining", { percent: view.remainingPct }),
    );
  } else {
    parts.push(t("ompAccountRouting.status.unknownUsage"));
  }
  if (view.resetAt !== null) {
    parts.push(
      t("ompAccountRouting.values.reset", { time: formatTimestamp(view.resetAt, locale) }),
    );
  }
  if (view.observedAt !== null) {
    parts.push(
      t("ompAccountRouting.values.observed", { time: formatTimestamp(view.observedAt, locale) }),
    );
  }
  if (view.stale) parts.push(t("ompAccountRouting.labels.stale"));
  return (
    <Text style={settingsStyles.rowHint}>
      {name}: {parts.join(" · ")}
    </Text>
  );
}

interface AccountRowViewProps {
  serverId: string;
  row: AccountRow;
  rows: readonly AccountRow[];
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  nowMs: number;
  locale: string;
  mutate: Mutate;
}

const AccountRowView = memo(function AccountRowView({
  serverId,
  row,
  rows,
  isFirst,
  isLast,
  disabled,
  nowMs,
  locale,
  mutate,
}: AccountRowViewProps) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const names = describeAccount(row, rows, {
    missing: (rowId) => t("ompAccountRouting.values.account", { row: rowId }),
    unknownOrganization: t("ompAccountRouting.labels.unknownOrganization"),
  });
  const refusal = accountRefusal(row, nowMs);
  const windows = useMemo(
    () => (row.account ? buildWindowViews(row.account, nowMs) : []),
    [row.account, nowMs],
  );
  const toggleIncluded = useCallback(
    (included: boolean) => mutate({ kind: "set_inclusion", account: row.ref, included }),
    [mutate, row.ref],
  );
  const moveUp = useCallback(
    () => mutate({ kind: "move_priority", account: row.ref, direction: "up" }),
    [mutate, row.ref],
  );
  const moveDown = useCallback(
    () => mutate({ kind: "move_priority", account: row.ref, direction: "down" }),
    [mutate, row.ref],
  );
  const badges: { id: string; label: string; variant: StatusBadgeVariant }[] = [];
  if (row.isCurrent)
    badges.push({
      id: "current",
      label: t("ompAccountRouting.labels.current"),
      variant: "success",
    });
  if (row.serving.length > 0)
    badges.push({
      id: "serving",
      label: t("ompAccountRouting.labels.serving"),
      variant: "success",
    });
  if (row.serving.length === 0 && row.lastServed.length > 0) {
    badges.push({
      id: "lastServed",
      label: t("ompAccountRouting.labels.lastServed"),
      variant: "muted",
    });
  }
  if (!row.included)
    badges.push({
      id: "excluded",
      label: t("ompAccountRouting.labels.excluded"),
      variant: "muted",
    });
  if (!row.account || row.account.missing) {
    badges.push({
      id: "missing",
      label: t("ompAccountRouting.labels.missing"),
      variant: "warning",
    });
  }
  return (
    <View
      style={[settingsStyles.row, compact && styles.compactRow]}
      testID={`omp-routing-row-${row.key}`}
    >
      <View style={styles.rowText}>
        <Text style={settingsStyles.rowTitle}>{names.title}</Text>
        {names.organization ? (
          <Text style={settingsStyles.rowHint}>{names.organization}</Text>
        ) : null}
        {badges.length > 0 ? (
          <View style={styles.badges}>
            {badges.map((badge) => (
              <StatusBadge key={badge.id} label={badge.label} variant={badge.variant} size="xs" />
            ))}
          </View>
        ) : null}
        {refusal ? (
          <Text style={refusal.kind === "quota" ? styles.refusalWarning : styles.refusal}>
            {t(`ompAccountRouting.reason.${refusal.code}`)}
          </Text>
        ) : null}
        {row.serving.map((request) => (
          <ServingLine
            key={request.admissionId}
            serverId={serverId}
            request={request}
            account={names.title}
          />
        ))}
        {windows.map((view) => (
          <WindowLine key={view.key} view={view} locale={locale} />
        ))}
        <Text style={settingsStyles.rowHint}>
          {t("ompAccountRouting.values.priority", { position: row.position })}
        </Text>
      </View>
      <View style={styles.rowControls}>
        <Switch
          value={row.included}
          onValueChange={toggleIncluded}
          disabled={disabled}
          accessibilityLabel={`${t("ompAccountRouting.labels.included")}: ${names.title}`}
          testID={`omp-routing-include-${row.key}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveUpIcon}
          onPress={moveUp}
          disabled={disabled || isFirst}
          accessibilityLabel={`${t("ompAccountRouting.actions.moveUp")}: ${names.title}`}
          testID={`omp-routing-up-${row.key}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveDownIcon}
          onPress={moveDown}
          disabled={disabled || isLast}
          accessibilityLabel={`${t("ompAccountRouting.actions.moveDown")}: ${names.title}`}
          testID={`omp-routing-down-${row.key}`}
        />
      </View>
    </View>
  );
});

function optionFor(
  row: AccountRow,
  rows: readonly AccountRow[],
  missingLabel: (rowId: number) => string,
  unknownOrganization: string,
): SelectFieldOption<OmpRoutingAccountRef> {
  const names = describeAccount(row, rows, { missing: missingLabel, unknownOrganization });
  return {
    id: row.key,
    value: row.ref,
    label: names.title,
    description: names.organization ?? undefined,
    testID: `omp-routing-option-${row.key}`,
  };
}

function MessageCard({ text }: { text: string }) {
  return (
    <View style={[settingsStyles.card, styles.messageCard]}>
      <Text style={styles.message}>{text}</Text>
    </View>
  );
}

interface ControlsBodyProps {
  serverId: string;
  state: OmpAccountRoutingState;
  disabled: boolean;
  mutate: Mutate;
}

function ControlsBody({ serverId, state, disabled, mutate }: ControlsBodyProps) {
  const { t, i18n } = useTranslation();
  const compact = useIsCompactFormFactor();
  const rows = useMemo(() => buildAccountRows(state), [state]);
  const missingLabel = useCallback(
    (rowId: number) => t("ompAccountRouting.values.account", { row: rowId }),
    [t],
  );
  const unknownOrganization = t("ompAccountRouting.labels.unknownOrganization");
  const options = useMemo(
    () => rows.map((row) => optionFor(row, rows, missingLabel, unknownOrganization)),
    [rows, missingLabel, unknownOrganization],
  );
  const currentRow = rows.find((row) => row.isCurrent) ?? null;
  const selectedDisplay = useMemo(() => {
    if (!currentRow) return null;
    const option = optionFor(currentRow, rows, missingLabel, unknownOrganization);
    return { label: option.label, description: option.description };
  }, [currentRow, rows, missingLabel, unknownOrganization]);
  const select = useCallback(
    (account: OmpRoutingAccountRef) => mutate({ kind: "select", account }),
    [mutate],
  );
  const setAuto = useCallback(
    (enabled: boolean) => mutate({ kind: "set_auto", enabled }),
    [mutate],
  );
  const nowMs = Date.now();

  return (
    <>
      <SettingsCard testID="omp-routing-controls">
        <SettingsRow label={t("ompAccountRouting.labels.account")}>
          <SelectField
            label={t("ompAccountRouting.labels.account")}
            field={false}
            size={compact ? "md" : "sm"}
            value={state.policy.current}
            selectedDisplay={selectedDisplay}
            options={options}
            getValueKey={refKey}
            onChange={select}
            placeholder={t("ompAccountRouting.reason.no_account")}
            emptyText={t("ompAccountRouting.status.empty")}
            searchable
            searchPlaceholder={t("ompAccountRouting.labels.search")}
            title={t("ompAccountRouting.labels.account")}
            disabled={disabled}
            testID="omp-routing-account-select"
            triggerTestID="omp-routing-account-trigger"
          />
        </SettingsRow>
        <SettingsSwitch
          label={t("ompAccountRouting.labels.auto")}
          value={state.policy.autoEnabled}
          onValueChange={setAuto}
          disabled={disabled}
          testID="omp-routing-auto"
        />
      </SettingsCard>
      <Text style={styles.listHint}>{t("ompAccountRouting.labels.priorityHelp")}</Text>
      <View style={settingsStyles.card} testID="omp-routing-accounts">
        {rows.map((row, index) => (
          <View key={row.key} style={index > 0 ? settingsStyles.rowBorder : undefined}>
            <AccountRowView
              serverId={serverId}
              row={row}
              rows={rows}
              isFirst={index === 0}
              isLast={index === rows.length - 1}
              disabled={disabled}
              nowMs={nowMs}
              locale={i18n.language}
              mutate={mutate}
            />
          </View>
        ))}
      </View>
    </>
  );
}

/** Host-global Claude account controls for the selected host's Providers page. */
export function AccountRoutingSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { snapshot, featureOn, connected, canEdit, mutate } = useHostAccountRouting(serverId);
  const { state } = snapshot;
  // Hidden until the host has ever advertised support; kept (disabled) once it has.
  if (!state && !(featureOn && connected)) return null;

  const offline = !connected || (featureOn && snapshot.offline);
  const section = state ? describeSection(state, snapshot.recoveries) : null;
  const unsupported = !featureOn || (section !== null && !section.capabilitySupported);
  const disabled = !state || snapshot.pending || offline || unsupported || !canEdit;
  const notices = buildNotices({
    state,
    recoveries: snapshot.recoveries,
    featureOn,
    offline,
    readOnly: state !== null && !canEdit,
    pending: snapshot.pending,
    conflict: snapshot.conflict,
    error: snapshot.error,
  });

  let body = <MessageCard text={t("ompAccountRouting.status.loading")} />;
  if (state && section?.catalog === "empty") {
    body = <MessageCard text={t("ompAccountRouting.status.empty")} />;
  } else if (state && section?.phase === "ready") {
    body = <ControlsBody serverId={serverId} state={state} disabled={disabled} mutate={mutate} />;
  }

  return (
    <SettingsSection
      title={t("ompAccountRouting.labels.title")}
      testID="host-account-routing-card"
      style={styles.section}
    >
      <Text style={styles.scope}>{t("ompAccountRouting.labels.scope")}</Text>
      {notices.map((notice) => (
        <Text
          key={notice.id}
          accessibilityRole={notice.alert ? "alert" : undefined}
          style={notice.alert ? styles.alert : styles.notice}
          testID={`omp-routing-notice-${notice.id}`}
        >
          {t(notice.key)}
        </Text>
      ))}
      {body}
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { marginTop: theme.spacing[4], marginBottom: theme.spacing[4], gap: theme.spacing[2] },
  scope: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  notice: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  alert: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  listHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
  },
  messageCard: { padding: theme.spacing[4], alignItems: "center" },
  message: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  compactRow: { flexWrap: "wrap", gap: theme.spacing[3] },
  rowText: { flexGrow: 1, flexShrink: 1, flexBasis: 200, gap: theme.spacing[1] },
  refusal: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  refusalWarning: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  rowControls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
}));
