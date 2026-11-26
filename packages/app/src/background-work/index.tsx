import { useCallback, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  ComposerTrackMark,
  ComposerTrackPill,
  ComposerTrackRow,
  type ComposerTrackPillSegment,
} from "@/composer/tracks";
import { LiveElapsed } from "@/components/message";
import { Button } from "@/components/ui/button";
import type { PaseoAgentBackgroundWorkItem } from "@getpaseo/client";
import type { AgentBackgroundWorkSummary } from "@getpaseo/protocol/messages";
import { createHostBackgroundWorkModel } from "./host";
import { backgroundWorkText, formatNextRunLabel, tallyBackgroundWork } from "./presentation";
export { createHostBackgroundWorkModel } from "./host";
export { formatNextRunLabel } from "./presentation";

function kindKey(kind: string): "shell" | "monitor" | "heartbeat" | "other" {
  if (kind === "shell" || kind === "monitor" || kind === "heartbeat") return kind;
  return "other";
}

export function BackgroundWorkTrack({
  model,
  summary,
}: {
  model: ReturnType<typeof createHostBackgroundWorkModel>;
  summary: AgentBackgroundWorkSummary;
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
  if (tally.running > 0) {
    segments.push({
      bucket: "running",
      text:
        tally.running === 1
          ? t("message.backgroundWork.pillOne")
          : t("message.backgroundWork.pillMany", { count: tally.running }),
    });
  }
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
  return (
    <ComposerTrackPill
      testID="background-work"
      panelTitle={t("message.backgroundWork.title")}
      segments={segments}
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
      {rows.map((item) => (
        <BackgroundWorkRow
          key={item.stopToken ?? item.id}
          item={item}
          model={model}
          live={Boolean(items?.some((entry) => entry.stopToken === item.stopToken))}
          ready={status === "ready"}
          stopStatus={stops?.[item.stopToken ?? ""]?.status}
        />
      ))}
    </ComposerTrackPill>
  );
}

function BackgroundWorkRow({
  item,
  model,
  live,
  ready,
  stopStatus,
}: {
  item: PaseoAgentBackgroundWorkItem;
  model: ReturnType<typeof createHostBackgroundWorkModel>;
  live: boolean;
  ready: boolean;
  stopStatus?: "pending" | "error";
}) {
  const { t } = useTranslation();
  const kind = t(`message.backgroundWork.${kindKey(item.kind)}`);
  const stop = useCallback(() => {
    void model.stopItem(item);
  }, [model, item]);
  const dismiss = useCallback(
    () => model.dismissStop(item.stopToken ?? ""),
    [model, item.stopToken],
  );
  let detail = t("message.backgroundWork.notRunning");
  if (stopStatus === "pending") detail = t("message.backgroundWork.stopping");
  const { title, command } = backgroundWorkText(item, kind);
  const action = item.canStop && ready && live;
  const label =
    stopStatus === "pending"
      ? t("message.backgroundWork.stopping")
      : t("message.backgroundWork.stop");
  return (
    <ComposerTrackRow>
      <View style={styles.row}>
        <Text style={styles.title}>{title}</Text>
        {command ? <Text style={styles.facts}>{command}</Text> : null}
        <View style={styles.factsLine}>
          {live && item.nextRunAt ? <ComposerTrackMark bucket="done" scheduled /> : null}
          <Text style={styles.facts}>
            {kind} · <BackgroundWorkTiming item={item} live={live} detail={detail} />
          </Text>
        </View>
        {stopStatus === "error" ? (
          <Text style={styles.facts}>{t("message.backgroundWork.stopError")}</Text>
        ) : null}
      </View>
      {action ? (
        <Button
          variant="ghost"
          size="sm"
          accessibilityLabel={`${t("message.backgroundWork.stop")} ${title}`}
          disabled={stopStatus === "pending"}
          onPress={stop}
        >
          {label}
        </Button>
      ) : null}
      {!live && stopStatus === "error" ? (
        <Button variant="ghost" size="sm" onPress={dismiss}>
          {t("message.backgroundWork.dismiss")}
        </Button>
      ) : null}
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
}));
