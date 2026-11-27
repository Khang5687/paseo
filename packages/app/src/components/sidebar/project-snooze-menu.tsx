import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { MenuItem, MenuSubTrigger, type MenuPageDefinition } from "@/components/ui/menu";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { selectHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceStructureHostPlacement } from "@/projects/workspace-structure";
import {
  projectSnoozedUntilMs,
  snoozeUntilDate,
  snoozeUntilMonday,
  snoozeUntilTomorrow,
} from "./project-snooze";

export const PROJECT_SNOOZE_PAGE_ID = "project-snooze";
const PROJECT_SNOOZE_DATE_PAGE_ID = "project-snooze-date";
/** "Until a date" offers the next two weeks, one tap each: no date picker, works on a phone. */
const DATE_CHOICE_DAYS = 14;

export interface SnoozeMenuProject {
  viewKey: string;
  projectName: string;
  hosts: readonly WorkspaceStructureHostPlacement[];
}

const NO_PAGES: readonly MenuPageDefinition[] = [];

function formatSnoozeTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDay(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function toIsoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The hosts of this project that can snooze; Snooze shows only when there is one. */
function useSnoozeHosts(project: SnoozeMenuProject): WorkspaceStructureHostPlacement[] {
  const supported = useSessionStore((state) =>
    project.hosts.map((host) => selectHostFeature(state, host.serverId, "projectSnooze")).join(),
  );
  return useMemo(() => {
    const flags = supported.split(",");
    return project.hosts.filter((_, index) => flags[index] === "true");
  }, [project.hosts, supported]);
}

/** Snoozes the project on every host that has it, so it folds the same on every device. */
function useSetSnooze(
  project: SnoozeMenuProject,
  hosts: readonly WorkspaceStructureHostPlacement[],
) {
  const { t } = useTranslation();
  const toast = useToast();
  return useCallback(
    (until: Date | null) => {
      const iso = until ? until.toISOString() : null;
      void Promise.all(
        hosts.map(async (host) => {
          const client = getHostRuntimeStore().getClient(host.serverId);
          if (!client) throw new Error("Host is not connected");
          await client.setProjectSnooze(host.projectId, iso);
        }),
      ).catch(() => toast.error(t("sidebar.project.snooze.failed", { name: project.projectName })));
    },
    [hosts, project.projectName, t, toast],
  );
}

/**
 * The Snooze pages of a project's menus: tomorrow, Monday, a day in the next two weeks, and Wake
 * now while snoozed. Each wakes the project at 08:00 local time. Pass the result as the menu
 * surface's `pages` and put `ProjectSnoozeSubTrigger` among the rows.
 */
export function useProjectSnoozeMenuPages(
  project: SnoozeMenuProject,
): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  const hosts = useSnoozeHosts(project);
  const setSnooze = useSetSnooze(project, hosts);
  return useMemo(() => {
    if (hosts.length === 0) return NO_PAGES;
    return [
      {
        id: PROJECT_SNOOZE_PAGE_ID,
        title: t("sidebar.project.snooze.title"),
        content: <SnoozePage project={project} onSnooze={setSnooze} />,
      },
      {
        id: PROJECT_SNOOZE_DATE_PAGE_ID,
        title: t("sidebar.project.snooze.datePage"),
        content: <SnoozeDatePage viewKey={project.viewKey} onSnooze={setSnooze} />,
      },
    ];
  }, [hosts.length, project, setSnooze, t]);
}

/** The Snooze row of a project's menu; shows the return time while snoozed. */
export function ProjectSnoozeSubTrigger({
  project,
}: {
  project: SnoozeMenuProject;
}): ReactElement | null {
  const { t } = useTranslation();
  const hosts = useSnoozeHosts(project);
  if (hosts.length === 0) return null;
  const until = projectSnoozedUntilMs(project.hosts, Date.now());
  return (
    <MenuSubTrigger
      id={PROJECT_SNOOZE_PAGE_ID}
      value={
        until === null
          ? undefined
          : t("sidebar.project.snooze.until", { time: formatSnoozeTime(until) })
      }
      indicator={until !== null}
      testID={`sidebar-project-menu-snooze-${project.viewKey}`}
    >
      {t("sidebar.project.snooze.title")}
    </MenuSubTrigger>
  );
}

function SnoozePage({
  project,
  onSnooze,
}: {
  project: SnoozeMenuProject;
  onSnooze: (until: Date | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const now = new Date();
  const tomorrow = snoozeUntilTomorrow(now);
  const monday = snoozeUntilMonday(now);
  const snoozed = projectSnoozedUntilMs(project.hosts, now.getTime()) !== null;
  const wake = useCallback(() => onSnooze(null), [onSnooze]);
  const pickTomorrow = useCallback(() => onSnooze(snoozeUntilTomorrow(new Date())), [onSnooze]);
  const pickMonday = useCallback(() => onSnooze(snoozeUntilMonday(new Date())), [onSnooze]);
  return (
    <>
      {snoozed ? (
        <MenuItem onSelect={wake} testID={`sidebar-project-snooze-wake-${project.viewKey}`}>
          {t("sidebar.project.snooze.wake")}
        </MenuItem>
      ) : null}
      <MenuItem
        description={formatSnoozeTime(tomorrow.getTime())}
        onSelect={pickTomorrow}
        testID={`sidebar-project-snooze-tomorrow-${project.viewKey}`}
      >
        {t("sidebar.project.snooze.tomorrow")}
      </MenuItem>
      <MenuItem
        description={formatSnoozeTime(monday.getTime())}
        onSelect={pickMonday}
        testID={`sidebar-project-snooze-monday-${project.viewKey}`}
      >
        {t("sidebar.project.snooze.monday")}
      </MenuItem>
      <MenuSubTrigger
        id={PROJECT_SNOOZE_DATE_PAGE_ID}
        testID={`sidebar-project-snooze-date-${project.viewKey}`}
      >
        {t("sidebar.project.snooze.date")}
      </MenuSubTrigger>
    </>
  );
}

function SnoozeDatePage({
  viewKey,
  onSnooze,
}: {
  viewKey: string;
  onSnooze: (until: Date | null) => void;
}): ReactElement {
  const days = useMemo(() => {
    const today = new Date();
    return Array.from({ length: DATE_CHOICE_DAYS }, (_, index) => {
      const day = new Date(today);
      day.setDate(today.getDate() + index + 1);
      return toIsoDay(day);
    });
  }, []);
  return (
    <>
      {days.map((isoDay) => (
        <SnoozeDayRow key={isoDay} isoDay={isoDay} viewKey={viewKey} onSnooze={onSnooze} />
      ))}
    </>
  );
}

function SnoozeDayRow({
  isoDay,
  viewKey,
  onSnooze,
}: {
  isoDay: string;
  viewKey: string;
  onSnooze: (until: Date | null) => void;
}): ReactElement | null {
  const until = snoozeUntilDate(isoDay, new Date());
  const pick = useCallback(() => {
    const at = snoozeUntilDate(isoDay, new Date());
    if (at) onSnooze(at);
  }, [isoDay, onSnooze]);
  if (!until) return null;
  return (
    <MenuItem onSelect={pick} testID={`sidebar-project-snooze-day-${isoDay}-${viewKey}`}>
      {formatDay(until)}
    </MenuItem>
  );
}
