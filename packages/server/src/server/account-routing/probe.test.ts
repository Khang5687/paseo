import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import { parseOmpCapabilityProbe } from "../agent/providers/omp/account-routing-bridge.js";
import { capabilityFromProbe, createOmpCapabilityProber } from "./probe.js";

const logger = pino({ level: "silent" });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(probe: ReturnType<typeof vi.fn>) {
  const setProbedCapability = vi.fn();
  const onLoginGuard = vi.fn();
  const prober = createOmpCapabilityProber({
    authority: { setProbedCapability },
    baseSettings: undefined,
    logger,
    probe,
    onLoginGuard,
  });
  return { prober, setProbedCapability, onLoginGuard };
}

const DOCUMENT = {
  version: 1,
  provider: "anthropic",
  managedAccountRouting: {
    modelDispatch: "allowed",
    completeCoverage: true,
    purposes: ["model-dispatch", "metadata", "usage-refresh"],
    sourceIdentity: "v1",
    exactUsageRefresh: "v1",
  },
};

describe("login guard", () => {
  it("reads login.existing from the capability document", () => {
    expect(parseOmpCapabilityProbe(JSON.stringify(DOCUMENT)).loginExisting).toBeFalsy();
    expect(
      parseOmpCapabilityProbe(JSON.stringify({ ...DOCUMENT, login: { existing: false } }))
        .loginExisting,
    ).toBeFalsy();
    expect(
      parseOmpCapabilityProbe(JSON.stringify({ ...DOCUMENT, login: { existing: true } })),
    ).toMatchObject({ complete: true, version: 1, loginExisting: true });
  });

  it("reports the guard on every probe and turns it off when OMP is disabled or the probe throws", async () => {
    const probe = vi.fn().mockResolvedValue({ complete: true, version: 1, loginExisting: true });
    const { prober, onLoginGuard } = setup(probe);
    prober.update(undefined);
    await flush();
    expect(onLoginGuard).toHaveBeenLastCalledWith(true);
    probe.mockResolvedValue({ complete: true, version: 1 });
    prober.update({ command: ["/opt/omp"] });
    await flush();
    expect(onLoginGuard).toHaveBeenLastCalledWith(false);
    probe.mockResolvedValue({ complete: true, version: 1, loginExisting: true });
    prober.update({ command: ["/opt/omp2"] });
    await flush();
    expect(onLoginGuard).toHaveBeenLastCalledWith(true);
    probe.mockRejectedValue(new Error("boom"));
    prober.update({ command: ["/opt/omp3"] });
    await flush();
    expect(onLoginGuard).toHaveBeenLastCalledWith(false);
    prober.update({ enabled: false });
    expect(onLoginGuard).toHaveBeenLastCalledWith(false);
  });
});

describe("capabilityFromProbe", () => {
  it("maps probe results to the capability a live runtime would report", () => {
    expect(capabilityFromProbe({ complete: true, version: 1 }).status).toBe("supported");
    expect(capabilityFromProbe({ complete: true, version: 2 }).status).toBe("unsupported");
    expect(capabilityFromProbe({ complete: false, version: 0 }).status).toBe("unsupported");
    expect(capabilityFromProbe({ complete: false, version: 0, unavailable: true }).status).toBe(
      "unknown",
    );
  });
});

describe("createOmpCapabilityProber", () => {
  it("probes once for an unchanged config and again when the OMP config changes", async () => {
    const probe = vi.fn().mockResolvedValue({ complete: true, version: 1 });
    const { prober, setProbedCapability } = setup(probe);
    prober.update(undefined);
    prober.update(undefined);
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(setProbedCapability).toHaveBeenLastCalledWith({ status: "supported", reason: null });
    probe.mockResolvedValue({ complete: false, version: 0 });
    prober.update({ command: ["/opt/omp"] });
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1]?.[0]?.command).toEqual({ mode: "replace", argv: ["/opt/omp"] });
    expect(setProbedCapability).toHaveBeenLastCalledWith({
      status: "unsupported",
      reason: "unsupported_runtime",
    });
  });

  it("calls onSupported after each probe that finds support, and only then", async () => {
    const onSupported = vi.fn();
    const probe = vi.fn().mockResolvedValue({ complete: true, version: 1 });
    const prober = createOmpCapabilityProber({
      authority: { setProbedCapability: vi.fn() },
      baseSettings: undefined,
      logger,
      probe,
      onSupported,
    });
    prober.update(undefined);
    await flush();
    expect(onSupported).toHaveBeenCalledTimes(1);
    prober.update(undefined);
    await flush();
    expect(onSupported).toHaveBeenCalledTimes(1);
    prober.update({ command: ["/opt/omp"] });
    await flush();
    expect(onSupported).toHaveBeenCalledTimes(2);
    probe.mockResolvedValue({ complete: false, version: 0 });
    prober.update({ command: ["/opt/other"] });
    probe.mockRejectedValueOnce(new Error("boom"));
    prober.update({ command: ["/opt/third"] });
    prober.update({ enabled: false });
    await flush();
    expect(onSupported).toHaveBeenCalledTimes(2);
  });

  it("reports unknown without probing when OMP is disabled", async () => {
    const probe = vi.fn();
    const { prober, setProbedCapability } = setup(probe);
    prober.update({ enabled: false });
    await flush();
    expect(probe).not.toHaveBeenCalled();
    expect(setProbedCapability).toHaveBeenLastCalledWith({ status: "unknown", reason: null });
  });

  it("reports unknown when the probe throws, and ignores a stale result", async () => {
    let release: (value: { complete: boolean; version: number }) => void = () => undefined;
    const probe = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockRejectedValueOnce(new Error("boom"));
    const { prober, setProbedCapability } = setup(probe);
    prober.update(undefined);
    prober.update({ command: ["/opt/omp"] });
    await flush();
    expect(setProbedCapability).toHaveBeenLastCalledWith({ status: "unknown", reason: null });
    setProbedCapability.mockClear();
    release({ complete: true, version: 1 });
    await flush();
    expect(setProbedCapability).not.toHaveBeenCalled();
  });
});
