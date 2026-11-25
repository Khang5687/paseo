import type pino from "pino";

import { PushService, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";

export type { PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushNotifications {
  renew(token: string): void;
  revoke(token: string): void;
  send(payload: PushPayload): Promise<void>;
  /**
   * Sends to named tokens, whatever their lease. For a push addressed to one device (a file sent
   * to it), which must arrive even when the phone has not connected for days.
   */
  sendToTokens(tokens: string[], payload: PushPayload): Promise<void>;
}

/** Broadcast pushes, and optionally pushes to named tokens (files sent to one device). */
export type PushNotificationSender = Pick<PushNotifications, "send"> &
  Partial<Pick<PushNotifications, "sendToTokens">>;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
  /** Called with a token the push service reported as dead, after it left the store. */
  onTokenRevoked?: (token: string) => void;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);
  const service = new PushService(options.logger, (token) => {
    store.revokeToken(token);
    options.onTokenRevoked?.(token);
  });
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload) => service.sendPush(tokens, payload));

  return {
    renew(token) {
      store.renewToken(token);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload) {
      const tokens = store.getActiveTokens();
      options.logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length === 0) return;
      await deliver(tokens, payload);
    },
    async sendToTokens(tokens, payload) {
      if (tokens.length === 0) return;
      options.logger.info({ tokenCount: tokens.length }, "Sending push notification to a device");
      await deliver(tokens, payload);
    },
  };
}
