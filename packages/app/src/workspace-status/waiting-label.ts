import type { TFunction } from "i18next";

/** What a settled chat waits on: its running background jobs and subagents. */
export interface WaitCounts {
  backgroundTaskCount: number;
  subagentCount: number;
}

/**
 * "Waiting on 1 background task", "Waiting on 2 subagents", or both in one line. Null when the
 * chat waits on nothing, so callers show no label.
 */
export function formatWaitingOnLabel(t: TFunction, wait: WaitCounts): string | null {
  const { backgroundTaskCount: taskCount, subagentCount } = wait;
  if (taskCount > 0 && subagentCount > 0) {
    return t("message.backgroundWork.waitingOnBoth", {
      tasks:
        taskCount === 1
          ? t("message.backgroundWork.pillOne")
          : t("message.backgroundWork.pillMany", { count: taskCount }),
      subagents:
        subagentCount === 1
          ? t("subagents.pillLabelOne")
          : t("subagents.pillLabelMany", { count: subagentCount }),
    });
  }
  if (taskCount > 0) {
    return taskCount === 1
      ? t("message.backgroundWork.waitingOnTasksOne")
      : t("message.backgroundWork.waitingOnTasksMany", { count: taskCount });
  }
  if (subagentCount > 0) {
    return subagentCount === 1
      ? t("message.backgroundWork.waitingOnSubagentsOne")
      : t("message.backgroundWork.waitingOnSubagentsMany", { count: subagentCount });
  }
  return null;
}
