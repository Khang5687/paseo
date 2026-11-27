import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getPushToken } from "@/push-notifications";
import { getFileDeviceIdentity } from "./identity";

/**
 * Tells a host what this device is called, and where its pushes go, each time the connection
 * comes up. The host's "Send to" list is built from these.
 */
export function startFileDeviceRegistration(input: {
  client: DaemonClient;
  serverId: string;
}): () => void {
  let stopped = false;
  const register = () => {
    if (stopped || !input.client.isConnected) return;
    void (async () => {
      const identity = getFileDeviceIdentity();
      const pushToken = await getPushToken(input.serverId);
      if (stopped || !input.client.isConnected) return;
      await input.client.registerFileDevice({
        name: identity.name,
        kind: identity.kind,
        ...(pushToken ? { pushToken } : {}),
      });
    })().catch((error) => console.warn("[SendTo] Failed to register this device", error));
  };
  register();
  const unsubscribe = input.client.subscribeConnectionStatus((state) => {
    if (state.status === "connected") register();
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}
