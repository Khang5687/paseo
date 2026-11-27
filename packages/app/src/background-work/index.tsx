import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import {
  ComposerTrackMark,
  ComposerTrackPill,
  ComposerTrackRow,
  type ComposerTrackPillSegment,
} from "@/composer/tracks";
import type { MenuPageDefinition } from "@/components/ui/menu";
import { LiveElapsed } from "@/components/message";
import { Button } from "@/components/ui/button";
import type { PaseoAgentBackgroundWorkItem } from "@getpaseo/client";
import type { AgentBackgroundWorkSummary } from "@getpaseo/protocol/messages";
import { createHostBackgroundWorkModel } from "./host";
import {
  backgroundWorkText,
  formatNextRunLabel,
  formatWaitingLabel,
  tallyBackgroundWork,
  WAITING_SHORT_TITLE_CHARS,
} from "./presentation";
export { createHostBackgroundWorkModel } from "./host";
export { formatNextRunLabel, formatWaitingLabel } from "./presentation";

type BackgroundWorkModel = ReturnType<typeof createHostBackgroundWorkModel>;

const COPIED_NOTICE_MS = 1500;
const NO_OUTPUT: readonly string[] = [];

type BackgroundWorkStops = ReturnType<BackgroundWorkModel["getSnapshot"]>["stops"];

function kindKey(kind: string): "shell" | "monitor" | "heartbeat" | "other" {
  if (kind === "shell" || kind === "monitor" || kind === "heartbeat") return kind;
  return "other";
}

function detailsPageId(item: PaseoAgentBackgroundWorkItem): string {
  return `background-work:${item.id}`;
}

/** A chat that waits on its jobs says so beside an hourglass; one still working counts them. */
function runningJobsSegment(
  t: TFunction,
  running: number,
  waits: boolean,
): ComposerTrackPillSegment {
  if (waits) {
    return {
      bucket: "running",
      waiting: true,
      text:
        running === 1
          ? t("message.backgroundWork.waitingOnTasksOne")
          : t("message.backgroundWork.waitingOnTasksMany", { count: running }),
    };
  }
  return {
    bucket: "running",
    text:
      running === 1
        ? t("message.backgroundWork.pillOne")
        : t("message.backgroundWork.pillMany", { count: running }),
  };
}

export function BackgroundWorkTrack({
  model,
  summary,
  waits = false,
}: {
  model: BackgroundWorkModel;
  summary: AgentBackgroundWorkSummary;
  /** The chat's turn ended and nothing in it is for you: its running jobs are what it waits on. */
  waits?: boolean;
}) {
  const { t } = useTranslation();
  const { items, status, stops } = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  );
  const missing = Object.values(stops ?? {}).filter(
    (entry) => !items?.some((item) => item.stopToken === entry.item.stopToken),
  );
  const rows = [...(items ?? []), ...missing.map((entry) => entry.item)];
  if (summary.count === 0 && rows.length === 0) return null;
  const tally = tallyBackgroundWork(items?.length ? items : null, summary);
  const segments: ComposerTrackPillSegment[] = [];
  if (tally.running > 0) segments.push(runningJobsSegment(t, tally.running, waits));
  if (tally.nextRunAt) {
    const next = formatNextRunLabel(tally.nextRunAt);
    segments.push({
      bucket: "done",
      scheduled: true,
      text:
        tally.scheduled === 1
          ? t("message.backgroundWork.scheduledOne", { next })
          : t("message.backgroundWork.scheduledMany", { count: tally.scheduled, next }),
    });
  }
  const ready = status === "ready";
  // Running jobs open a details page; heartbeats say all they have on the row.
  const pages: MenuPageDefinition[] = (items ?? [])
    .filter((item) => !item.nextRunAt)
    .map((item) => ({
      id: detailsPageId(item),
      title: backgroundWorkText(item, t(`message.backgroundWork.${kindKey(item.kind)}`)).title,
      hoverIntent: false,
      content: (
        <BackgroundWorkDetails
          item={item}
          model={model}
          ready={ready}
          stopStatus={stops?.[item.stopToken ?? ""]?.status}
        />
      ),
    }));
  return (
    <>
      {summary.waitingOn ? (
        <BackgroundWorkWaitingPill
          waitingOn={summary.waitingOn}
          item={items?.find((item) => item.id === summary.waitingOn?.itemId) ?? null}
          model={model}
          ready={ready}
          stops={stops}
        />
      ) : null}
      <ComposerTrackPill
        testID="background-work"
        panelTitle={t("message.backgroundWork.title")}
        segments={segments}
        pages={pages}
      >
        {status === "loading" || status === "stale" ? (
          <ComposerTrackRow>
            <Text style={styles.facts}>{t("message.backgroundWork.waiting")}</Text>
          </ComposerTrackRow>
        ) : null}
        {status === "error" ? (
          <>
            <ComposerTrackRow>
              <Text style={styles.facts}>{t("message.backgroundWork.error")}</Text>
            </ComposerTrackRow>
            <ComposerTrackRow
              onPress={model.retry}
              closeOnSelect={false}
              accessibilityLabel={t("message.backgroundWork.retry")}
            >
              <Text style={styles.title}>{t("message.backgroundWork.retry")}</Text>
            </ComposerTrackRow>
          </>
        ) : null}
        {rows.map((item) => {
          const live = Boolean(items?.some((entry) => entry.stopToken === item.stopToken));
          return (
            <BackgroundWorkRow
              key={item.stopToken ?? item.id}
              item={item}
              model={model}
              live={live}
              ready={ready}
              opensPage={live && !item.nextRunAt ? detailsPageId(item) : undefined}
              stopStatus={stops?.[item.stopToken ?? ""]?.status}
            />
          );
        })}
      </ComposerTrackPill>
    </>
  );
}

/**
 * The turn is blocked on a job: an hourglass and the job's name in place of a bare spinner.
 * Tapping it opens that job's details directly.
 */
function BackgroundWorkWaitingPill({
  waitingOn,
  item,
  model,
  ready,
  stops,
}: {
  waitingOn: NonNullable<AgentBackgroundWorkSummary["waitingOn"]>;
  item: PaseoAgentBackgroundWorkItem | null;
  model: BackgroundWorkModel;
  ready: boolean;
  stops: BackgroundWorkStops;
}) {
  const { t } = useTranslation();
  const label = formatWaitingLabel(waitingOn.title, WAITING_SHORT_TITLE_CHARS);
  return (
    <ComposerTrackPill
      testID="background-work-waiting"
      panelTitle={formatWaitingLabel(waitingOn.title)}
      accessibilityLabel={formatWaitingLabel(waitingOn.title)}
      segments={[{ bucket: "running", waiting: true, text: label }]}
    >
      {item ? (
        <BackgroundWorkDetails
          item={item}
          model={model}
          ready={ready}
          stopStatus={stops?.[item.stopToken ?? ""]?.status}
        />
      ) : (
        <ComposerTrackRow>
          <Text style={styles.facts}>{t("message.backgroundWork.waiting")}</Text>
        </ComposerTrackRow>
      )}
    </ComposerTrackPill>
  );
}

function BackgroundWorkRow({
  item,
  model,
  live,
  ready,
  opensPage,
  stopStatus,
}: {
  item: PaseoAgentBackgroundWorkItem;
  model: BackgroundWorkModel;
  live: boolean;
  ready: boolean;
  opensPage?: string;
  stopStatus?: "pending" | "error";
}) {
  const { t } = useTranslation();
  const kind = t(`message.backgroundWork.${kindKey(item.kind)}`);
  const dismiss = useCallback(
    () => model.dismissStop(item.stopToken ?? ""),
    [model, item.stopToken],
  );
  let detail = t("message.backgroundWork.notRunning");
  if (stopStatus === "pending") detail = t("message.backgroundWork.stopping");
  const { title, command } = backgroundWorkText(item, kind);
  const lastLine = live ? item.outputTail?.at(-1) : undefined;
  const previousLine = live ? item.outputTail?.at(-2) : undefined;
  return (
    <ComposerTrackRow
      opensPage={opensPage}
      accessibilityLabel={title}
      testID={`background-work-row-${item.id}`}
    >
      <View style={styles.row}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {command ? (
          <Text style={styles.facts} numberOfLines={1}>
            {command}
          </Text>
        ) : null}
        <View style={styles.factsLine}>
          {live && item.nextRunAt ? <ComposerTrackMark bucket="done" scheduled /> : null}
          <Text style={styles.facts}>
            {kind} · <BackgroundWorkTiming item={item} live={live} detail={detail} />
          </Text>
        </View>
        {/* The last two lines, oldest first; each its own line so a long one cannot hide the next. */}
        {previousLine !== undefined ? (
          <Text style={styles.output} numberOfLines={1}>
            {previousLine}
          </Text>
        ) : null}
        {lastLine !== undefined ? (
          <Text style={styles.output} numberOfLines={1} testID="background-work-row-output">
            {lastLine}
          </Text>
        ) : null}
        {stopStatus === "error" ? (
          <Text style={styles.facts}>{t("message.backgroundWork.stopError")}</Text>
        ) : null}
      </View>
      <BackgroundWorkStopButton
        item={item}
        model={model}
        title={title}
        enabled={live && ready}
        stopStatus={stopStatus}
      />
      {!live && stopStatus === "error" ? (
        <Button variant="ghost" size="sm" onPress={dismiss}>
          {t("message.backgroundWork.dismiss")}
        </Button>
      ) : null}
    </ComposerTrackRow>
  );
}

function BackgroundWorkStopButton({
  item,
  model,
  title,
  enabled,
  stopStatus,
}: {
  item: PaseoAgentBackgroundWorkItem;
  model: BackgroundWorkModel;
  title: string;
  enabled: boolean;
  stopStatus?: "pending" | "error";
}) {
  const { t } = useTranslation();
  const stop = useCallback(() => {
    void model.stopItem(item);
  }, [model, item]);
  if (!item.canStop || !enabled) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      accessibilityLabel={`${t("message.backgroundWork.stop")} ${title}`}
      disabled={stopStatus === "pending"}
      onPress={stop}
    >
      {stopStatus === "pending"
        ? t("message.backgroundWork.stopping")
        : t("message.backgroundWork.stop")}
    </Button>
  );
}

/**
 * Everything known about one running job: why the agent started it, what it runs, how long it has
 * run, and its latest output as it arrives.
 */
function BackgroundWorkDetails({
  item,
  model,
  ready,
  stopStatus,
}: {
  item: PaseoAgentBackgroundWorkItem;
  model: BackgroundWorkModel;
  ready: boolean;
  stopStatus?: "pending" | "error";
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const kind = t(`message.backgroundWork.${kindKey(item.kind)}`);
  const { title } = backgroundWorkText(item, kind);
  const output = item.outputTail ?? NO_OUTPUT;
  const startedAt = new Date(item.startedAt);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copyOutput = useCallback(() => {
    void Clipboard.setStringAsync(output.join("\n")).then(() => setCopied(true));
  }, [output]);
  return (
    <View testID="background-work-details">
      {item.description ? (
        <BackgroundWorkDetailsSection label={t("message.backgroundWork.detailsWhy")}>
          <Text style={styles.title}>{item.description}</Text>
        </BackgroundWorkDetailsSection>
      ) : null}
      {item.command ? (
        <BackgroundWorkDetailsSection label={t("message.backgroundWork.detailsCommand")}>
          <Text style={styles.output} selectable>
            {item.command}
          </Text>
        </BackgroundWorkDetailsSection>
      ) : null}
      <BackgroundWorkDetailsSection label={t("message.backgroundWork.detailsStarted")}>
        <Text style={styles.facts}>
          {startedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ·{" "}
          {t("message.backgroundWork.detailsRunning")}{" "}
          <LiveElapsed startedAt={startedAt} active style={styles.facts} />
        </Text>
      </BackgroundWorkDetailsSection>
      <BackgroundWorkDetailsSection label={t("message.backgroundWork.detailsOutput")}>
        {output.length ? (
          <Text
            style={[styles.output, styles.outputBlock]}
            selectable
            testID="background-work-details-output"
          >
            {output.join("\n")}
          </Text>
        ) : (
          <Text style={styles.facts}>{t("message.backgroundWork.detailsNoOutput")}</Text>
        )}
      </BackgroundWorkDetailsSection>
      <ComposerTrackRow>
        <View style={styles.actions}>
          <BackgroundWorkStopButton
            item={item}
            model={model}
            title={title}
            enabled={ready}
            stopStatus={stopStatus}
          />
          {output.length ? (
            <Button variant="ghost" size="sm" onPress={copyOutput}>
              {copied
                ? t("message.backgroundWork.detailsCopied")
                : t("message.backgroundWork.detailsCopy")}
            </Button>
          ) : null}
        </View>
      </ComposerTrackRow>
      {stopStatus === "error" ? (
        <ComposerTrackRow>
          <Text style={styles.facts}>{t("message.backgroundWork.stopError")}</Text>
        </ComposerTrackRow>
      ) : null}
    </View>
  );
}

function BackgroundWorkDetailsSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ComposerTrackRow>
      <View style={styles.row}>
        <Text style={styles.sectionLabel}>{label}</Text>
        {children}
      </View>
    </ComposerTrackRow>
  );
}

/** Scheduled work says when it next runs; running work counts up; gone work says so. */
function BackgroundWorkTiming({
  item,
  live,
  detail,
}: {
  item: PaseoAgentBackgroundWorkItem;
  live: boolean;
  detail: string;
}) {
  if (!live) return detail;
  if (item.nextRunAt) return formatNextRunLabel(item.nextRunAt);
  return <LiveElapsed startedAt={new Date(item.startedAt)} active style={styles.facts} />;
}

const styles = StyleSheet.create((theme) => ({
  row: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
  title: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  facts: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  factsLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  output: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
  },
  outputBlock: { paddingTop: theme.spacing[1] },
  sectionLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingBottom: theme.spacing[0.5],
  },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
}));
