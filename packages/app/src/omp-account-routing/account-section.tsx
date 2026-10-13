import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { UsageMeter } from "@/usage/meter";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  buildAccountRows,
  buildWindowViews,
  accountRefusal,
  describeAccount,
  addAccountMode,
  buildNotices,
  describeSection,
  formatTimestamp,
  quotaLimit,
  refKey,
  summarizeRouting,
  type AccountRow,
  type ServingRequest,
  type WindowView,
} from "./presentation";
import { useHostAccountLogin, useHostAccountRouting, type HostAccountLogin } from "./queries";

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

function windowName(view: WindowView, t: TFunction): string {
  if (view.kind === "fiveHour") return t("ompAccountRouting.labels.fiveHour");
  if (view.kind === "weekly") return t("ompAccountRouting.labels.weekly");
  if (view.kind === "model" && view.period) {
    const period = t(`ompAccountRouting.labels.${view.period}`);
    return `${period} (${view.model ?? view.serverLabel})`;
  }
  return view.serverLabel;
}

function WindowLine({ view, locale }: { view: WindowView; locale: string }) {
  const { t } = useTranslation();
  const parts: string[] =
    view.consumedPct === null
      ? [t("ompAccountRouting.status.unknownUsage")]
      : [t("ompAccountRouting.values.used", { percent: view.consumedPct })];
  if (view.resetAt !== null) {
    parts.push(
      t("ompAccountRouting.values.reset", { time: formatTimestamp(view.resetAt, locale) }),
    );
  }
  // A fresh reading is current by definition; the time only helps when it is old.
  if (view.stale && view.observedAt !== null) {
    parts.push(
      t("ompAccountRouting.values.observed", { time: formatTimestamp(view.observedAt, locale) }),
    );
  }
  return (
    <View style={styles.windowLine}>
      <Text style={settingsStyles.rowHint}>
        {windowName(view, t)}: {parts.join(" · ")}
      </Text>
      {view.consumedPct === null ? null : (
        <UsageMeter percent={view.consumedPct} tone={view.tone} style={styles.meter} />
      )}
    </View>
  );
}

/** A quota refusal names the full window and its reset; other refusals keep the reason's text. */
function refusalCopy(
  refusal: NonNullable<ReturnType<typeof accountRefusal>>,
  windows: readonly WindowView[],
  t: TFunction,
  locale: string,
): string {
  const limit = refusal.kind === "quota" ? quotaLimit(windows) : null;
  if (!limit) return t(`ompAccountRouting.reason.${refusal.code}`);
  const window = windowName(limit, t);
  if (limit.resetAt === null) return t("ompAccountRouting.values.limitReached", { window });
  return t("ompAccountRouting.values.limitReachedReset", {
    window,
    time: formatTimestamp(limit.resetAt, locale),
  });
}

interface AccountRowViewProps {
  serverId: string;
  row: AccountRow;
  rows: readonly AccountRow[];
  isFirst: boolean;
  isLast: boolean;
  /** Ordering only means something with two or more accounts. */
  showOrder: boolean;
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
  showOrder,
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
  const refusalText = refusal && refusalCopy(refusal, windows, t, locale);
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
            {refusalText}
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
        {showOrder ? (
          <Text style={settingsStyles.rowHint}>
            {t("ompAccountRouting.values.priority", { position: row.position })}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowControls}>
        <Text style={settingsStyles.rowHint}>{t("ompAccountRouting.labels.useForAuto")}</Text>
        <Switch
          value={row.included}
          onValueChange={toggleIncluded}
          disabled={disabled}
          accessibilityLabel={`${t("ompAccountRouting.labels.useForAuto")}: ${names.title}`}
          testID={`omp-routing-include-${row.key}`}
        />
        {showOrder ? (
          <>
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
          </>
        ) : null}
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

function AddAccountHint() {
  const { t } = useTranslation();
  return (
    <Text style={styles.listHint} testID="omp-routing-add-hint">
      {t("ompAccountRouting.labels.addAccountHint")}
    </Text>
  );
}

interface AddAccountProps {
  login: HostAccountLogin;
  canEdit: boolean;
  disabled: boolean;
}

/** Sign-in happens in the host's own browser, so only the desktop app on that computer starts it. */
function AddAccount({ login, canEdit, disabled }: AddAccountProps) {
  const { t } = useTranslation();
  const mode = addAccountMode({
    featureOn: login.featureOn,
    canEdit,
    onHostComputer: login.onHostComputer,
  });
  if (mode === "terminal") return <AddAccountHint />;
  if (mode === "elsewhere") {
    return (
      <>
        <Text style={styles.listHint} testID="omp-routing-add-elsewhere">
          {t("ompAccountRouting.login.elsewhere")}
        </Text>
        <AddAccountHint />
      </>
    );
  }

  const { phase, failure } = login.snapshot;
  const running = phase === "starting" || phase === "running";
  let result: string | null = null;
  if (phase === "succeeded") result = t("ompAccountRouting.login.saved");
  else if (phase === "cancelled") result = t("ompAccountRouting.login.cancelled");
  else if (phase === "failed")
    result = t(`ompAccountRouting.login.failure.${failure ?? "omp_failed"}`);
  return (
    <View style={styles.addAccount} testID="omp-routing-add-account">
      <Text style={styles.listHint}>
        {running ? t("ompAccountRouting.login.running") : t("ompAccountRouting.login.explain")}
      </Text>
      {result ? (
        <Text
          accessibilityRole={phase === "failed" ? "alert" : undefined}
          style={phase === "failed" ? styles.alert : styles.notice}
          testID="omp-routing-add-result"
        >
          {result}
        </Text>
      ) : null}
      <View style={styles.rowControls}>
        {running ? (
          <Button
            variant="outline"
            size="sm"
            onPress={login.cancel}
            disabled={phase === "starting"}
            testID="omp-routing-add-cancel"
          >
            {t("ompAccountRouting.login.cancel")}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onPress={login.start}
            disabled={disabled}
            testID="omp-routing-add-button"
          >
            {t("ompAccountRouting.login.start")}
          </Button>
        )}
      </View>
    </View>
  );
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
  login: HostAccountLogin;
  canEdit: boolean;
}

function ControlsBody({ serverId, state, disabled, mutate, login, canEdit }: ControlsBodyProps) {
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
  const summary = summarizeRouting(state, rows, nowMs);
  const showOrder = rows.length >= 2;
  let summaryText: string | null = null;
  if (summary?.kind === "paused") {
    summaryText =
      summary.resumesAt === null
        ? t("ompAccountRouting.status.summaryPaused")
        : t("ompAccountRouting.status.summaryPausedResumes", {
            time: formatTimestamp(summary.resumesAt, i18n.language),
          });
  } else if (summary?.kind === "using") {
    const account = describeAccount(summary.row, rows, {
      missing: missingLabel,
      unknownOrganization,
    }).title;
    summaryText = t("ompAccountRouting.status.summaryUsing", { account });
  } else if (summary?.kind === "auto") {
    summaryText = t("ompAccountRouting.status.summaryAuto");
  }

  return (
    <>
      {summaryText ? (
        <Text
          style={summary?.kind === "paused" ? styles.summaryPaused : styles.summary}
          testID="omp-routing-summary"
        >
          {summaryText}
        </Text>
      ) : null}
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
            placeholder={
              state.policy.autoEnabled
                ? t("ompAccountRouting.labels.automatic")
                : t("ompAccountRouting.reason.no_account")
            }
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
      {showOrder ? (
        <Text style={styles.listHint}>{t("ompAccountRouting.labels.priorityHelp")}</Text>
      ) : null}
      <View style={settingsStyles.card} testID="omp-routing-accounts">
        {rows.map((row, index) => (
          <View key={row.key} style={index > 0 ? settingsStyles.rowBorder : undefined}>
            <AccountRowView
              serverId={serverId}
              row={row}
              rows={rows}
              isFirst={index === 0}
              isLast={index === rows.length - 1}
              showOrder={showOrder}
              disabled={disabled}
              nowMs={nowMs}
              locale={i18n.language}
              mutate={mutate}
            />
          </View>
        ))}
      </View>
      <AddAccount login={login} canEdit={canEdit} disabled={disabled} />
    </>
  );
}

/** Host-global Claude account controls for the selected host's Providers page. */
export function AccountRoutingSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { snapshot, featureOn, connected, canEdit, mutate } = useHostAccountRouting(serverId);
  const login = useHostAccountLogin(serverId);
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
    body = (
      <>
        <MessageCard text={t("ompAccountRouting.status.empty")} />
        <AddAccount login={login} canEdit={canEdit} disabled={offline} />
      </>
    );
  } else if (state && section?.phase === "ready") {
    body = (
      <ControlsBody
        serverId={serverId}
        state={state}
        disabled={disabled}
        mutate={mutate}
        login={login}
        canEdit={canEdit}
      />
    );
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
  summary: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  summaryPaused: { color: theme.colors.statusWarning, fontSize: theme.fontSize.base },
  windowLine: { gap: theme.spacing[1] },
  meter: { maxWidth: 280 },
  addAccount: { gap: theme.spacing[2] },
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
  rowControls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
}));
