import pino from "pino";
import { describe, expect, test } from "vitest";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";
import type { OmpRuntime, OmpStartSessionInput } from "../agent/providers/omp/runtime.js";
import { FakeOmp } from "../agent/providers/omp/test-utils/fake-omp.js";
import { createConfiguredOmpRuntime, createOmpAccountLister } from "./listing.js";

const logger = pino({ level: "silent" });
const ROW_7 = { credentialId: 7, label: "a@example.test (Org A)", type: "oauth" };
const ROW_9 = { credentialId: 9, label: "b@example.test", type: "oauth" };
const KEY = { credentialId: 3, label: "API key #3", type: "api_key" };

function setup(known = true) {
  const published: Array<{ source: string; rows: unknown }> = [];
  const omp = new FakeOmp();
  const inputs: OmpStartSessionInput[] = [];
  const runtime: OmpRuntime = {
    startSession: (input) => {
      inputs.push(input);
      return omp.startSession(input);
    },
  };
  const lister = createOmpAccountLister({
    authority: {
      publishListing: (source, rows) => {
        published.push({ source, rows });
        return known;
      },
    },
    runtime,
    logger,
  });
  return { omp, inputs, lister, published };
}

describe("createOmpAccountLister", () => {
  test("publishes oauth labels from one plain read-only child and closes it", async () => {
    const { omp, inputs, lister, published } = setup();
    omp.queueSessionSetup((s) => {
      s.logoutAccounts = [ROW_7, KEY, ROW_9];
    });
    await lister.refresh("listing");
    expect(published).toEqual([
      {
        source: "listing",
        rows: [
          { nativeRowId: 7, label: "a@example.test (Org A)" },
          { nativeRowId: 9, label: "b@example.test" },
        ],
      },
    ]);
    // Only the listing call ran: no routing launch, no login, no model or prompt traffic.
    expect(inputs).toHaveLength(1);
    expect(inputs[0].routing).toBeUndefined();
    const session = omp.latestSession();
    expect(session.getLogoutAccountsRequests).toBe(1);
    expect(session.loginRequests).toEqual([]);
    expect(session.closed).toBe(true);
  });

  test("a failing child or listing is logged, never thrown, and publishes nothing", async () => {
    const { omp, lister, published } = setup();
    omp.failNextStart(new Error("spawn failed"));
    await expect(lister.refresh("listing")).resolves.toBeUndefined();
    omp.queueSessionSetup((s) => {
      s.logoutAccountsError = new Error("store locked");
    });
    await expect(lister.refresh("listing")).resolves.toBeUndefined();
    expect(published).toEqual([]);
    expect(omp.latestSession().closed).toBe(true);
  });

  test("a refresh during a read becomes one follow-up read", async () => {
    const { omp, lister, published } = setup();
    omp.queueSessionSetup((s) => {
      s.logoutAccounts = [ROW_7];
    });
    omp.queueSessionSetup((s) => {
      s.logoutAccounts = [ROW_7, ROW_9];
    });
    const first = lister.refresh("listing");
    void lister.refresh("login");
    await lister.refresh("login");
    await first;
    expect(published.map((p) => p.source)).toEqual(["listing", "login"]);
    expect(published[1].rows).toHaveLength(2);
  });

  test("an unknown store publishes nothing the authority accepts and does not throw", async () => {
    const { omp, lister, published } = setup(false);
    omp.queueSessionSetup((s) => {
      s.logoutAccounts = [ROW_7];
    });
    await lister.refresh("listing");
    expect(published).toHaveLength(1);
  });
});

describe("createConfiguredOmpRuntime", () => {
  test("reads the OMP launch settings at each session, so a config change applies at once", async () => {
    let settings: ProviderRuntimeSettings | undefined = {
      command: { mode: "replace", argv: ["custom-omp"] },
      env: { OMP_HOME: "/synthetic" },
    };
    const seen: Array<ProviderRuntimeSettings | undefined> = [];
    const omp = new FakeOmp();
    const runtime = createConfiguredOmpRuntime(
      logger,
      () => settings,
      (runtimeSettings) => {
        seen.push(runtimeSettings);
        return omp;
      },
    );
    await runtime.startSession({ cwd: "/tmp", protocolMode: "rpc", noSession: true });
    settings = undefined;
    await runtime.startSession({ cwd: "/tmp", protocolMode: "rpc", noSession: true });
    expect(seen).toEqual([
      { command: { mode: "replace", argv: ["custom-omp"] }, env: { OMP_HOME: "/synthetic" } },
      undefined,
    ]);
  });
});
