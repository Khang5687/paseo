import { describe, expect, test } from "vitest";

import { mapOmpRuntimeEventToTimelineItem } from "./event-mapper.js";
import { OmpXdevMountNotices } from "./xdev-mount-notice.js";

const GMAIL_TOOLS = ["download_attachment", "read_email", "search_emails"];
const gmailNames = (account: string) =>
  GMAIL_TOOLS.map((tool) => `mcp__gmail_${account}_${account}_${tool}`);

function xdevNotice(message: string, source: string | undefined = "xdev") {
  return { type: "notice", level: "info", message, ...(source ? { source } : {}) };
}

function mountRow(message: string, notices = new OmpXdevMountNotices(), source?: string) {
  const mapped = mapOmpRuntimeEventToTimelineItem(xdevNotice(message, source), notices);
  if (!mapped.handled || !mapped.item || mapped.item.type !== "tool_call") {
    throw new Error(`Expected an MCP servers row, got ${JSON.stringify(mapped)}`);
  }
  const { detail, metadata } = mapped.item;
  if (detail.type !== "plain_text") throw new Error("Expected plain_text detail");
  return { item: mapped.item, label: detail.label, text: detail.text, metadata };
}

describe("OMP xd:// mount notices", () => {
  test("collapses a mount of two servers with underscored names into one row", () => {
    const row = mountRow(
      `xd://: mounted ${[...gmailNames("usa"), ...gmailNames("vn")].join(", ")}`,
    );

    expect(row.item).toMatchObject({ name: "mcp_servers", status: "completed" });
    expect(row.label).toBe("Gmail Usa, Gmail Vn connected (6 tools)");
    expect(row.metadata).toMatchObject({
      added: [
        {
          server: "gmail_usa",
          label: "Gmail Usa",
          tools: ["usa_download_attachment", "usa_read_email", "usa_search_emails"],
        },
        {
          server: "gmail_vn",
          label: "Gmail Vn",
          tools: ["vn_download_attachment", "vn_read_email", "vn_search_emails"],
        },
      ],
      removed: [],
    });
    expect(row.text).toBe(
      [
        "Connected",
        "Gmail Usa (3 tools)",
        "  usa_download_attachment",
        "  usa_read_email",
        "  usa_search_emails",
        "Gmail Vn (3 tools)",
        "  vn_download_attachment",
        "  vn_read_email",
        "  vn_search_emails",
      ].join("\n"),
    );
  });

  test("keeps one account's server id when it mounts alone", () => {
    const row = mountRow(`xd://: mounted ${gmailNames("usa").join(", ")}`);

    expect(row.label).toBe("Gmail Usa connected (3 tools)");
  });

  test("splits servers by first token and keeps verb-prefixed tools under their server", () => {
    const row = mountRow(
      "xd://: mounted mcp__github_create_issue, mcp__github_create_pr, mcp__github_list_issues, mcp__github_list_prs, mcp__chrome_devtools_click, mcp__chrome_devtools_fill_form, mcp__chrome_devtools_take_snapshot, mcp__context7_resolve_library_id",
    );

    expect(row.metadata).toMatchObject({
      added: [
        { server: "github", tools: ["create_issue", "create_pr", "list_issues", "list_prs"] },
        { server: "chrome_devtools", tools: ["click", "fill_form", "take_snapshot"] },
        { server: "context7", tools: ["resolve_library_id"] },
      ],
    });
    expect(row.label).toBe("Github, Chrome Devtools, Context7 connected (8 tools)");
  });

  test("keeps the shared word in tool names when only two tools share it", () => {
    const row = mountRow(
      "xd://: mounted mcp__notebooklm_notebook_create, mcp__notebooklm_notebook_list",
    );

    expect(row.metadata).toMatchObject({
      added: [{ server: "notebooklm", tools: ["notebook_create", "notebook_list"] }],
    });
  });

  test("names more than three servers by count", () => {
    const row = mountRow(
      "xd://: mounted mcp__alpha_a, mcp__beta_b, mcp__gamma_c, mcp__delta_d, mcp__epsilon_e",
    );

    expect(row.label).toBe("Alpha, Beta, Gamma +2 more connected (5 tools)");
  });

  test("describes an unmount", () => {
    const row = mountRow(`xd://: unmounted ${gmailNames("vn").join(", ")}`);

    expect(row.label).toBe("Gmail Vn disconnected (3 tools)");
    expect(row.text?.split("\n")[0]).toBe("Disconnected");
  });

  test("puts a mount and an unmount from one notice in one row", () => {
    const row = mountRow(
      `xd://: mounted ${gmailNames("usa").join(", ")}; unmounted mcp__notebooklm_notebook_create, browser`,
    );

    expect(row.label).toBe(
      "Gmail Usa connected (3 tools) · Notebooklm, browser disconnected (2 tools)",
    );
    expect(row.text).toContain("\n\nDisconnected\nNotebooklm (1 tool)\n  notebook_create\nbrowser");
  });

  test("recognizes the xd:// prefix when OMP omits the notice source", () => {
    const row = mountRow("xd://: mounted mcp__porkbun_check_domain", undefined, undefined);

    expect(row.label).toBe("Porkbun connected (1 tool)");
  });

  test("leaves notices from other sources and unparseable xd:// text as plain notifications", () => {
    expect(
      mapOmpRuntimeEventToTimelineItem(xdevNotice("xd://: mounted mcp__a_b", "extensions")).item,
    ).toEqual({ type: "notification", level: "info", message: "xd://: mounted mcp__a_b" });
    expect(mapOmpRuntimeEventToTimelineItem(xdevNotice("xd://: refreshed devices")).item).toEqual({
      type: "notification",
      level: "info",
      message: "xd://: refreshed devices",
    });
  });

  test("drops an exact repeat but shows a remount after an unmount", () => {
    const notices = new OmpXdevMountNotices();
    const mount = `xd://: mounted ${gmailNames("usa").join(", ")}`;
    const reordered = `xd://: mounted ${gmailNames("usa").toReversed().join(", ")}`;
    const first = mountRow(mount, notices);

    expect(mapOmpRuntimeEventToTimelineItem(xdevNotice(mount), notices)).toEqual({
      handled: true,
      item: null,
      logReason: "repeated_omp_xdev_mount_notice",
    });
    expect(mapOmpRuntimeEventToTimelineItem(xdevNotice(reordered), notices).item).toBeNull();
    // Other notices between two identical mounts do not make the repeat new.
    mapOmpRuntimeEventToTimelineItem(
      xdevNotice("Provider quota is getting low", "anthropic"),
      notices,
    );
    expect(mapOmpRuntimeEventToTimelineItem(xdevNotice(mount), notices).item).toBeNull();

    const unmount = mountRow(`xd://: unmounted ${gmailNames("usa").join(", ")}`, notices);
    const remount = mountRow(mount, notices);

    expect(unmount.label).toBe("Gmail Usa disconnected (3 tools)");
    expect(remount.label).toBe("Gmail Usa connected (3 tools)");
    expect(new Set([first.item.callId, unmount.item.callId, remount.item.callId]).size).toBe(3);
  });
});

describe("OMP runtime event mapper", () => {
  test("maps notice events to timeline notifications", () => {
    const event = {
      type: "notice",
      level: "warning",
      message: "Provider quota is getting low",
      source: "anthropic",
    };

    expect(mapOmpRuntimeEventToTimelineItem(event)).toMatchObject({
      handled: true,
      item: {
        type: "notification",
        level: "warning",
        message: "Provider quota is getting low",
      },
    });
  });

  test("maps goal_updated events to provider notices and timeline status lines", () => {
    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "goal_updated",
        goal: {
          id: "goal-1",
          objective: "Ship Phase 5",
          status: "active",
          tokenBudget: 2000,
          tokensUsed: 345,
          timeUsedSeconds: 12,
        },
        state: {
          enabled: true,
          mode: "active",
        },
      }),
    ).toMatchObject({
      handled: true,
      item: {
        type: "tool_call",
        callId: "omp-goal:goal-1",
        name: "omp_goal_updated",
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          label: "OMP goal active",
          text: "Ship Phase 5\nStatus: active\nTokens used: 345\nToken budget: 2000\nTime used: 12s\nMode: active",
          icon: "brain",
        },
        metadata: {
          synthetic: true,
          source: "omp_goal_updated",
          goalId: "goal-1",
          goalStatus: "active",
        },
      },
    });
  });

  test("maps retry telemetry to status-line timeline items", () => {
    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 25,
        errorMessage: "retrying",
        errorId: 7,
      }),
    ).toMatchObject({
      handled: true,
      item: {
        type: "tool_call",
        callId: "omp-auto-retry:1",
        name: "omp_auto_retry",
        status: "running",
        error: null,
        detail: {
          type: "plain_text",
          label: "OMP retry 1/3",
          text: "Retrying in 25ms: retrying",
          icon: "sparkles",
        },
        metadata: {
          source: "omp_auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 25,
          errorId: 7,
        },
      },
    });

    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError: "still failed",
      }),
    ).toMatchObject({
      handled: true,
      item: {
        type: "tool_call",
        callId: "omp-auto-retry:1",
        name: "omp_auto_retry",
        status: "failed",
        error: "still failed",
        detail: {
          type: "plain_text",
          label: "OMP retry 1 failed",
          text: "still failed",
          icon: "sparkles",
        },
      },
    });

    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "retry_fallback_applied",
        from: "anthropic/claude-sonnet",
        to: "openai/gpt-5",
        role: "primary",
      }),
    ).toMatchObject({
      handled: true,
      item: {
        type: "tool_call",
        name: "omp_retry_fallback",
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          label: "OMP fallback applied for primary",
          text: "anthropic/claude-sonnet -> openai/gpt-5",
          icon: "sparkles",
        },
        metadata: {
          source: "omp_retry_fallback_applied",
          role: "primary",
          from: "anthropic/claude-sonnet",
          to: "openai/gpt-5",
        },
      },
    });

    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "retry_fallback_succeeded",
        model: "openai/gpt-5",
        role: "primary",
      }),
    ).toMatchObject({
      handled: true,
      item: {
        type: "tool_call",
        name: "omp_retry_fallback",
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          label: "OMP fallback succeeded for primary",
          text: "Using openai/gpt-5",
          icon: "sparkles",
        },
        metadata: {
          source: "omp_retry_fallback_succeeded",
          role: "primary",
          model: "openai/gpt-5",
        },
      },
    });
  });

  test("maps auto compaction events to compaction timeline items", () => {
    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "auto_compaction_start",
        reason: "threshold",
        action: "context-full",
      }),
    ).toEqual({
      handled: true,
      item: {
        type: "compaction",
        status: "loading",
        trigger: "auto",
      },
    });

    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "auto_compaction_end",
        action: "context-full",
        result: {
          summary: "trimmed",
          shortSummary: "trimmed",
          firstKeptEntryId: "entry-1",
          tokensBefore: 123,
        },
        aborted: false,
        willRetry: false,
      }),
    ).toEqual({
      handled: true,
      item: {
        type: "compaction",
        status: "completed",
        trigger: "auto",
        preTokens: 123,
      },
    });

    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "auto_compaction_end",
        aborted: true,
        willRetry: true,
        skipped: true,
        errorMessage: "compaction failed",
      }),
    ).toEqual({
      handled: true,
      item: {
        type: "compaction",
        status: "completed",
        trigger: "auto",
      },
    });
  });

  test("leaves unknown events unhandled", () => {
    expect(mapOmpRuntimeEventToTimelineItem({ type: "message_start" })).toEqual({
      handled: false,
    });
  });

  test("log-drops malformed known OMP events", () => {
    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "notice",
        level: "loud",
        message: "bad",
      }),
    ).toEqual({
      handled: true,
      item: null,
      logReason: "malformed_omp_notice",
    });
  });
});
