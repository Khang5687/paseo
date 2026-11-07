import { describe, expect, test } from "vitest";

import type { OmpRuntimeEvent } from "./rpc-types.js";
import {
  buildOmpRpcUiPermissionResponse,
  classifyOmpRpcUiPermissionRequest,
  readOmpModeBashApprovalCommand,
} from "./rpc-ui-permission-mapper.js";

type ExtensionUiRequestEvent = Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>;

const RPC_UI_CASES: ExtensionUiRequestEvent[] = [
  { type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "status" },
  { type: "extension_ui_request", id: "notify", method: "notify", message: "done" },
  {
    type: "extension_ui_request",
    id: "bash",
    method: "select",
    title: "Allow tool: bash\nCommand: echo rpc-ui-hi",
    options: ["Approve", "Deny"],
  },
  {
    type: "extension_ui_request",
    id: "edit",
    method: "select",
    title: "Allow tool: edit\nFile: fixture.txt",
    options: ["Approve", "Deny"],
  },
  {
    type: "extension_ui_request",
    id: "write",
    method: "select",
    title: "Allow tool: write\nPath: created.txt\nContent:\nhello write",
    options: ["Approve", "Deny"],
  },
];

function toolApproval(id: string) {
  const event = RPC_UI_CASES.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`Missing RPC-UI case ${id}`);
  const classification = classifyOmpRpcUiPermissionRequest(event);
  if (classification.kind !== "tool") throw new Error(`Expected ${id} to be a tool approval`);
  return classification.request;
}

describe("OMP rpc-ui permission mapper", () => {
  test("classifies tool approvals and passes through unrelated UI requests", () => {
    expect(
      RPC_UI_CASES.map((event) => {
        const classification = classifyOmpRpcUiPermissionRequest(event);
        return [event.id, classification.kind];
      }),
    ).toEqual([
      ["widget", "passthrough"],
      ["notify", "passthrough"],
      ["bash", "tool"],
      ["edit", "tool"],
      ["write", "tool"],
    ]);
  });

  test("maps tool approvals to renderable permissions", () => {
    expect([toolApproval("bash"), toolApproval("edit"), toolApproval("write")]).toEqual([
      expect.objectContaining({
        id: "bash",
        provider: "omp",
        name: "bash",
        kind: "tool",
        detail: { type: "shell", command: "echo rpc-ui-hi" },
        metadata: expect.objectContaining({
          toolName: "bash",
          toolArgs: { command: "echo rpc-ui-hi" },
          approveValue: "Approve",
          denyValue: "Deny",
        }),
      }),
      expect.objectContaining({
        id: "edit",
        provider: "omp",
        name: "edit",
        kind: "tool",
        detail: { type: "edit", filePath: "fixture.txt" },
        metadata: expect.objectContaining({ toolName: "edit", toolArgs: { path: "fixture.txt" } }),
      }),
      expect.objectContaining({
        id: "write",
        provider: "omp",
        name: "write",
        kind: "tool",
        detail: { type: "write", filePath: "created.txt", content: "hello write" },
        metadata: expect.objectContaining({
          toolName: "write",
          toolArgs: { path: "created.txt", content: "hello write" },
        }),
      }),
    ]);
  });

  test("preserves destructive multiline CRLF bash commands exactly", () => {
    const title = "Allow tool: bash\r\nCommand: printf first\r\n\r\n  rm -rf /tmp/example\r\n";
    const classification = classifyOmpRpcUiPermissionRequest({
      type: "extension_ui_request",
      id: "multiline-bash",
      method: "select",
      title,
      options: ["Approve", "Deny"],
    });
    if (classification.kind !== "tool") throw new Error("Expected multiline bash approval");

    expect(classification.request.detail).toEqual({
      type: "shell",
      command: "printf first\r\n\r\n  rm -rf /tmp/example\r\n",
    });
    expect(classification.request.metadata?.toolArgs).toEqual({
      command: "printf first\r\n\r\n  rm -rf /tmp/example\r\n",
    });
  });

  test("rejects approval lookalikes and unknown tools", () => {
    expect(
      classifyOmpRpcUiPermissionRequest({
        type: "extension_ui_request",
        id: "not-tool",
        method: "select",
        title: "Allow tool: bash\nCommand: echo hi",
        options: ["Yes", "No"],
      }),
    ).toEqual({ kind: "passthrough" });
    expect(
      classifyOmpRpcUiPermissionRequest({
        type: "extension_ui_request",
        id: "unknown-tool",
        method: "select",
        title: "Allow tool: custom_tool\nReason: needs approval",
        options: ["Approve", "Deny"],
      }),
    ).toEqual({ kind: "passthrough" });
  });

  test("responds to tool approvals with exact select values", () => {
    const request = toolApproval("bash");

    expect(buildOmpRpcUiPermissionResponse(request, { behavior: "allow" })).toEqual({
      value: "Approve",
    });
    expect(
      buildOmpRpcUiPermissionResponse(request, {
        behavior: "allow",
        selectedActionId: "allow_always",
      }),
    ).toEqual({ value: "Approve" });
    expect(buildOmpRpcUiPermissionResponse(request, { behavior: "deny", message: "no" })).toEqual({
      value: "Deny",
    });
  });

  test("reads the command only from plain mode-raised bash approvals", () => {
    const bash = (title: string, options: string[]): ExtensionUiRequestEvent => ({
      type: "extension_ui_request",
      id: "bash",
      method: "select",
      title,
      options,
    });
    const sessionOptions = ["Approve", "Approve bash for this session", "Deny"];

    expect(
      readOmpModeBashApprovalCommand(bash("Allow tool: bash\nCommand: git status", sessionOptions)),
    ).toBe("git status");
    expect(
      readOmpModeBashApprovalCommand(bash("Allow tool: bash\nCommand: ls", ["Approve", "Deny"])),
    ).toBe("ls");

    for (const event of [
      // A reason means a rule or safety override asked, not the approval mode.
      bash("Allow tool: bash\nReason: matched prompt rule\nCommand: ls", sessionOptions),
      // Provider safety checks follow the command.
      bash("Allow tool: bash\nCommand: ls\nProvider safety checks:\n- check", ["Approve", "Deny"]),
      // OMP cut the command; the rest is not shown.
      bash(`Allow tool: bash\nCommand: ls ${"a".repeat(10)}[…120ch elided…]`, sessionOptions),
      bash("Allow tool: edit\nCommand: ls", sessionOptions),
      bash("Allow tool: bash\nCommand: ls", ["Approve once", "Deny"]),
      bash("Allow tool: bash\nCommand: ls", ["Approve", "Approve edit for this session", "Deny"]),
      { ...bash("Allow tool: bash\nCommand: ls", sessionOptions), method: "input" as const },
    ]) {
      expect(readOmpModeBashApprovalCommand(event)).toBeNull();
    }
  });
});
