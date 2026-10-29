import { describe, expect, test } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
} from "../messages.js";
import {
  DAEMON_PERMISSIONS,
  OWNER_PERMISSIONS,
  SessionAuthorization,
  permissionsForLegacyHubScopes,
  parseDaemonPermissions,
} from "./index.js";

function inboundOperationTypes(): SessionInboundMessage["type"][] {
  return SessionInboundMessageSchema.options.map((option) => option.shape.type.value);
}

function outboundOperationTypes(): SessionOutboundMessage["type"][] {
  return SessionOutboundMessageSchema.options.map((option) => option.shape.type.value);
}

function inboundMessage(type: SessionInboundMessage["type"]): SessionInboundMessage {
  return { type } as SessionInboundMessage;
}

function outboundMessage(type: SessionOutboundMessage["type"]): SessionOutboundMessage {
  if (type === "status")
    return {
      type,
      payload: { status: "agent_create_failed", error: "test", requestId: "test" },
    } as SessionOutboundMessage;
  return { type } as SessionOutboundMessage;
}

describe("SessionAuthorization", () => {
  test("owner authority covers every session operation", () => {
    const authorization = new SessionAuthorization(OWNER_PERMISSIONS);

    expect(
      inboundOperationTypes().every((type) => authorization.allowsInbound(inboundMessage(type))),
    ).toBe(true);
    expect(
      outboundOperationTypes().every((type) => authorization.allowsOutbound(outboundMessage(type))),
    ).toBe(true);
  });

  test("account routing separates read and manage permissions", () => {
    const readAuthorization = new SessionAuthorization(["daemon.read"]);
    expect(
      readAuthorization.allowsInbound(inboundMessage("account.routing.get_state.request")),
    ).toBe(true);
    expect(
      readAuthorization.allowsOutbound(outboundMessage("account.routing.get_state.response")),
    ).toBe(true);
    expect(readAuthorization.allowsOutbound(outboundMessage("account.routing.state.update"))).toBe(
      true,
    );
    expect(readAuthorization.allowsInbound(inboundMessage("account.routing.mutate.request"))).toBe(
      false,
    );
    expect(
      readAuthorization.allowsOutbound(outboundMessage("account.routing.mutate.response")),
    ).toBe(false);

    const manageAuthorization = new SessionAuthorization(["daemon.manage"]);
    expect(
      manageAuthorization.allowsInbound(inboundMessage("account.routing.mutate.request")),
    ).toBe(true);
    expect(
      manageAuthorization.allowsOutbound(outboundMessage("account.routing.mutate.response")),
    ).toBe(true);
    expect(
      manageAuthorization.allowsInbound(inboundMessage("account.routing.get_state.request")),
    ).toBe(false);
    expect(
      manageAuthorization.allowsOutbound(outboundMessage("account.routing.get_state.response")),
    ).toBe(false);
    expect(
      manageAuthorization.allowsOutbound(outboundMessage("account.routing.state.update")),
    ).toBe(false);
  });

  test("account login needs daemon.manage; read-only and workspace authority are refused", () => {
    const requests = [
      "account.routing.login.start.request",
      "account.routing.login.get_status.request",
      "account.routing.login.cancel.request",
      "account.routing.login.submit_code.request",
    ] as const;
    const responses = [
      "account.routing.login.start.response",
      "account.routing.login.get_status.response",
      "account.routing.login.cancel.response",
      "account.routing.login.submit_code.response",
    ] as const;
    const refused = [
      new SessionAuthorization(["daemon.read"]),
      new SessionAuthorization(["workspace.read", "workspace.write", "workspace.manage"]),
    ];
    const manage = new SessionAuthorization(["daemon.manage"]);
    for (const type of requests) {
      expect(manage.allowsInbound(inboundMessage(type))).toBe(true);
      for (const authorization of refused) {
        expect(authorization.allowsInbound(inboundMessage(type))).toBe(false);
      }
    }
    for (const type of responses) {
      expect(manage.allowsOutbound(outboundMessage(type))).toBe(true);
      for (const authorization of refused) {
        expect(authorization.allowsOutbound(outboundMessage(type))).toBe(false);
      }
    }
  });

  test("workspace and hub authority never reach account routing", () => {
    const authorization = new SessionAuthorization([
      "workspace.read",
      "workspace.write",
      "workspace.manage",
      "hub.execute",
    ]);
    for (const type of [
      "account.routing.get_state.request",
      "account.routing.mutate.request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(false);
    }
    expect(authorization.allowsOutbound(outboundMessage("account.routing.state.update"))).toBe(
      false,
    );
  });

  test("semantic permissions authorize operations instead of RPC namespaces", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);

    expect(authorization.allowsInbound(inboundMessage("hub.execution.agent.create.request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("hub.execution.agent.update"))).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsInbound(inboundMessage("refresh_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("get_providers_snapshot_response"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("providers_snapshot_update"))).toBe(true);
    expect(
      authorization.allowsOutbound(outboundMessage("refresh_providers_snapshot_response")),
    ).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_daemon_config_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("provider_diagnostic_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("ping"))).toBe(false);
    expect(
      authorization.allowsInbound(inboundMessage("hub.management.daemon.get_status.request")),
    ).toBe(false);
  });

  test("Hub can operate ordinary agents and recover workspaces without daemon administration", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);
    for (const type of [
      "create_agent_request",
      "workspace.title.set.request",
      "fetch_agents_request",
      "fetch_agent_request",
      "agent.timeline.set_subscription.request",
      "send_agent_message_request",
      "workspace.recovery.inspect.request",
      "workspace.recovery.restore.request",
      "archive_workspace_request",
      "cancel_agent_request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(true);
    }
    for (const type of [
      "status",
      "agent_update",
      "agent_stream",
      "workspace_update",
      "rpc_error",
      "workspace.title.set.response",
      "fetch_agents_response",
      "fetch_agent_response",
      "agent.timeline.set_subscription.response",
      "send_agent_message_response",
      "workspace.recovery.inspect.response",
      "workspace.recovery.restore.response",
      "archive_workspace_response",
      "cancel_agent_response",
    ] as const) {
      expect(authorization.allowsOutbound(outboundMessage(type))).toBe(true);
    }
    for (const type of [
      "restart_server_request",
      "terminal_input",
      "hub.management.daemon.permissions.update.request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(false);
    }
    expect(
      authorization.allowsOutbound({
        type: "status",
        payload: { status: "shutdown_requested", clientId: "owner", requestId: "shutdown" },
      }),
    ).toBe(false);
    authorization.replacePermissions([]);
    expect(authorization.allowsInbound(inboundMessage("send_agent_message_request"))).toBe(false);
    expect(authorization.allowsOutbound(outboundMessage("agent_update"))).toBe(false);
  });

  test("correlated authorization errors can always be emitted", () => {
    const authorization = new SessionAuthorization([]);

    expect(authorization.allowsOutbound(outboundMessage("rpc_error"))).toBe(true);
  });

  test("legacy Hub authority is translated at one compatibility boundary", () => {
    expect(permissionsForLegacyHubScopes(["hub.execution.*"])).toEqual(["hub.execute"]);
    expect(permissionsForLegacyHubScopes(["*"])).toEqual([]);
  });

  test("permission names are semantic", () => {
    expect(
      DAEMON_PERMISSIONS.every(
        (permission) => !permission.includes("*") && !permission.includes("request"),
      ),
    ).toBe(true);
  });

  test("permission parsing validates against the shared registry and removes duplicates", () => {
    expect(parseDaemonPermissions(["hub.execute", "hub.execute"])).toEqual(["hub.execute"]);
    expect(() => parseDaemonPermissions(["hub.execution.*"])).toThrow("Invalid daemon permission");
  });
});
