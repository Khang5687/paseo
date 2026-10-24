import { expect, test } from "vitest";

import { buildOmpLaunch } from "./runtime.js";
import { OmpHarness } from "./test-utils/omp-harness.js";

test("falls back to progress when the event subscription is unavailable", async () => {
  const omp = new OmpHarness();
  omp.failEventSubscription(new Error("events unsupported"));
  await omp.start();

  await expect(omp.waitForSubscriptionFallback()).resolves.toEqual(["events", "progress"]);
});

test("a host routing request never reaches the launch argv or environment", () => {
  const routing = { authority: {} as never, agentId: "agent-1" };
  const plain = buildOmpLaunch({ command: ["omp"], session: { cwd: "/w" } });
  const routed = buildOmpLaunch({ command: ["omp"], session: { cwd: "/w", routing } });

  expect(routed.argv).toEqual(plain.argv);
  expect(routed.env).toEqual(plain.env);
});
