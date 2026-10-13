import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, test } from "vitest";
import type { OmpRoutingAccountRef } from "@getpaseo/protocol/messages";
import { FakeOmp, type FakeOmpSession } from "../agent/providers/omp/test-utils/fake-omp.js";
import { OmpAccountLogin, parseCallbackInput } from "./login.js";

const AUTHORIZE_URL =
  "https://claude.ai/oauth/authorize?client_id=x&code_challenge=SECRETCHALLENGE&state=STATE1";
const NS = "11111111-1111-4111-8111-111111111111";
const ref = (nativeRowId: number): OmpRoutingAccountRef => ({ storeNamespace: NS, nativeRowId });
const ROW_7 = { credentialId: 7, label: "a@example.com (Org A)", type: "oauth" };
const ROW_9 = { credentialId: 9, label: "b@example.com (Org B)", type: "oauth" };

function setup(options: { timeoutMs?: number; namespace?: string | null } = {}) {
  const lines: string[] = [];
  const logger = pino(
    { level: "trace" },
    new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    }),
  );
  const omp = new FakeOmp();
  const added: OmpRoutingAccountRef[] = [];
  const namespace = options.namespace === undefined ? NS : options.namespace;
  const login = new OmpAccountLogin({
    runtime: omp,
    logger,
    timeoutMs: options.timeoutMs,
    accounts: {
      refForSignedInRow: (nativeRowId) =>
        namespace ? { storeNamespace: namespace, nativeRowId } : null,
      addSignedInAccount: (account) => void added.push(account),
    },
  });
  return { omp, login, lines, added };
}

async function settled(login: OmpAccountLogin) {
  for (let i = 0; i < 400; i += 1) {
    if (login.status().state !== "running") return login.status();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("login never settled");
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

const ended = (login: OmpAccountLogin) => () => login.status().state !== "running";
const phaseIs = (login: OmpAccountLogin, phase: string) => () => login.status().phase === phase;
const pasteOpen =
  (login: OmpAccountLogin, open = true) =>
  () =>
    (login.status().pasteAccepted === true) === open;

function script(
  omp: FakeOmp,
  handler: NonNullable<FakeOmpSession["loginHandler"]>,
  accounts = [ROW_7],
) {
  omp.queueSessionSetup((session) => {
    session.logoutAccounts = accounts;
    session.loginHandler = handler;
  });
}

const emitOpenUrl = (session: FakeOmpSession, url = AUTHORIZE_URL) =>
  session.emit({ type: "extension_ui_request", id: "ui-1", method: "open_url", url });
const emitInput = (session: FakeOmpSession, id = "ui-2") =>
  session.emit({ type: "extension_ui_request", id, method: "input", title: "Paste code" });
/** Resolves with what the host answered to the paste prompt `id`. */
async function answerTo(session: FakeOmpSession, id = "ui-2") {
  let answer: { value?: string; cancelled?: boolean } | undefined;
  await waitFor(() => {
    answer = session.extensionUiResponses.find((r) => r.id === id)?.response;
    return answer !== undefined;
  });
  return answer!;
}

describe("OmpAccountLogin", () => {
  test("shows the link in status instead of opening a browser, and adds a new row", async () => {
    const { omp, login, added } = setup();
    let linkSeen = false;
    script(omp, async (s) => {
      emitOpenUrl(s);
      await waitFor(phaseIs(login, "awaiting_browser"));
      linkSeen = login.status().authorizeUrl === AUTHORIZE_URL;
      s.logoutAccounts = [ROW_7, ROW_9];
      return {
        kind: "stored",
        outcome: "added",
        rowId: 9,
        email: "b@example.com",
        orgName: "Org B",
      };
    });

    expect(login.status()).toEqual({ state: "idle" });
    expect(login.start()).toMatchObject({
      error: null,
      status: { state: "running", phase: "preparing" },
    });
    const done = await settled(login);
    expect(linkSeen).toBe(true);
    expect(done).toMatchObject({
      state: "succeeded",
      outcome: { kind: "added", label: "b@example.com", organizationLabel: "Org B", ref: ref(9) },
    });
    expect(done.endedAt).toEqual(expect.any(Number));
    expect(done.authorizeUrl).toBeUndefined();
    expect(added).toEqual([ref(9)]);

    const session = omp.latestSession();
    expect(session.loginRequests).toEqual(["anthropic"]);
    expect(session.loginOptions).toEqual([{ existing: "refuse" }]);
    expect(session.getLogoutAccountsRequests).toBe(2);
    await waitFor(() => session.closed);
    expect(omp.recordedLaunches[0]).toMatchObject({ noSession: true, protocolMode: "rpc" });
    expect(session.prompts).toEqual([]);
  });

  test("an OMP without the outcome report gets it from the store listing", async () => {
    const { omp, login, added } = setup();
    script(omp, async (s) => {
      s.logoutAccounts = [ROW_7, ROW_9, { credentialId: 10, label: "key", type: "api_key" }];
    });
    login.start();
    expect(await settled(login)).toMatchObject({
      state: "succeeded",
      outcome: { kind: "added", label: ROW_9.label, ref: ref(9) },
    });
    expect(added).toEqual([ref(9)]);
  });

  test("no new row in the listing reports an overwrite, and no listing reports nothing", async () => {
    const { omp, login, added } = setup();
    script(omp, async () => undefined);
    login.start();
    expect((await settled(login)).outcome).toEqual({ kind: "replaced" });

    omp.queueSessionSetup((session) => {
      session.logoutAccountsError = new Error("unknown command");
    });
    login.start();
    const done = await settled(login);
    expect(done.state).toBe("succeeded");
    expect(done.outcome).toBeUndefined();
    expect(added).toEqual([]);
  });

  test("a refused duplicate fails as already listed and writes no policy", async () => {
    const { omp, login, added } = setup();
    script(omp, async () => ({ kind: "credential_exists", rowId: 7, email: "a@example.com" }));
    login.start();
    expect(await settled(login)).toMatchObject({
      state: "failed",
      failure: "omp_failed",
      outcome: { kind: "already_listed", label: "a@example.com", ref: ref(7) },
    });
    expect(added).toEqual([]);
  });

  test("replace mode names the target row and reports the overwrite", async () => {
    const { omp, login, added } = setup();
    script(omp, async () => ({ kind: "stored", outcome: "replaced", rowId: 7 }));
    login.start({ replace: ref(7) });
    expect(await settled(login)).toMatchObject({
      state: "succeeded",
      outcome: { kind: "replaced", label: ROW_7.label, ref: ref(7) },
    });
    expect(omp.latestSession().loginOptions).toEqual([{ existing: { replaceRowId: 7 } }]);
    expect(added).toEqual([]);
  });

  test("an unknown store keeps the label but no ref, and writes no policy", async () => {
    const { omp, login, added } = setup({ namespace: null });
    script(omp, async () => ({
      kind: "stored",
      outcome: "added",
      rowId: 9,
      email: "b@example.com",
    }));
    login.start();
    expect((await settled(login)).outcome).toEqual({ kind: "added", label: "b@example.com" });
    expect(added).toEqual([]);
  });

  test("keeps OMP's paste prompt open while the loopback callback wins", async () => {
    const { omp, login } = setup();
    script(omp, async (s) => {
      emitOpenUrl(s);
      emitInput(s);
      await waitFor(pasteOpen(login));
      // Before the fix the host cancelled this prompt, OMP asked again, and a later failure read
      // as paste_code_unsupported.
      await new Promise((r) => setTimeout(r, 20));
      expect(s.extensionUiResponses).toEqual([]);
      s.emit({
        type: "extension_ui_request",
        id: "ui-3",
        method: "notify",
        message: "Exchanging authorization code for tokens...",
      });
      await waitFor(phaseIs(login, "verifying"));
      s.emit({ type: "extension_ui_request", id: "ui-4", method: "cancel", targetId: "ui-2" });
      await waitFor(pasteOpen(login, false));
      expect(login.submitCode("abc")).toBe("not_waiting");
      return { kind: "stored", outcome: "added", rowId: 9 };
    });
    login.start();
    expect(await settled(login)).toMatchObject({ state: "succeeded" });
    expect(omp.latestSession().canceledExtensionUiRequests).toEqual([]);
  });

  test("an OMP failure after the paste prompt is omp_failed", async () => {
    const { omp, login } = setup();
    script(omp, async (s) => {
      emitOpenUrl(s);
      emitInput(s);
      throw new Error("token exchange failed");
    });
    login.start();
    expect(await settled(login)).toMatchObject({ state: "failed", failure: "omp_failed" });
    expect(omp.latestSession().canceledExtensionUiRequests).toEqual([]);
  });

  test("submit_code forwards only a parsed code whose state matches the link", async () => {
    const { omp, login } = setup();
    expect(login.submitCode("abc")).toBe("not_waiting");
    script(omp, async (s) => {
      emitOpenUrl(s);
      await waitFor(phaseIs(login, "awaiting_browser"));
      expect(login.submitCode("abc")).toBe("not_waiting");
      emitInput(s);
      await waitFor(pasteOpen(login));
      expect(login.submitCode("   ")).toBe("invalid_input");
      expect(login.submitCode("http://localhost:54545/callback?error=denied")).toBe(
        "invalid_input",
      );
      expect(login.submitCode("http://localhost:54545/callback?code=C1&state=OLD")).toBe(
        "wrong_login",
      );
      expect(s.extensionUiResponses).toEqual([]);
      expect(
        login.submitCode("http://localhost:54545/callback?code=SECRETCODE&state=STATE1"),
      ).toBeNull();
      expect(await answerTo(s)).toEqual({ value: "SECRETCODE#STATE1" });
      expect(login.status()).toMatchObject({ phase: "verifying" });
      expect(login.status().pasteAccepted).toBeUndefined();
      expect(login.status().authorizeUrl).toBeUndefined();
      expect(login.submitCode("SECRETCODE#STATE1")).toBe("not_waiting");
      return { kind: "stored", outcome: "added", rowId: 9 };
    });
    login.start();
    expect(await settled(login)).toMatchObject({ state: "succeeded" });
    expect(login.submitCode("abc")).toBe("not_waiting");
  });

  test("parses the forms OMP accepts", () => {
    expect(parseCallbackInput("http://localhost:1/cb?code=a&state=s")).toEqual({
      code: "a",
      state: "s",
    });
    expect(parseCallbackInput("code=a&state=s")).toEqual({ code: "a", state: "s" });
    expect(parseCallbackInput(" a#s ")).toEqual({ code: "a", state: "s" });
    expect(parseCallbackInput("a")).toEqual({ code: "a" });
    expect(parseCallbackInput("a b")).toBeNull();
    expect(parseCallbackInput("#s")).toBeNull();
    expect(parseCallbackInput("x".repeat(4097))).toBeNull();
  });

  test("a URL that is not https fails the login and is never shown", async () => {
    const { omp, login } = setup();
    script(omp, async (s) => {
      emitOpenUrl(s, "file:///etc/passwd");
      await waitFor(ended(login));
    });
    login.start();
    const done = await settled(login);
    expect(done).toMatchObject({ state: "failed", failure: "omp_failed" });
    expect(JSON.stringify(done)).not.toContain("passwd");
  });

  test("a login that never finishes times out and kills the process", async () => {
    const { omp, login } = setup({ timeoutMs: 30 });
    script(omp, () => new Promise(() => undefined));

    login.start();
    expect(await settled(login)).toMatchObject({ state: "failed", failure: "timeout" });
    await waitFor(() => omp.latestSession().closed);
  });

  test("cancel stops a running login and closes its paste prompt", async () => {
    const { omp, login } = setup();
    script(omp, async (s) => {
      emitOpenUrl(s);
      emitInput(s);
      await new Promise(() => undefined);
    });

    login.start();
    await waitFor(pasteOpen(login));
    expect(login.cancel()).toMatchObject({ state: "cancelled" });
    expect(login.status().authorizeUrl).toBeUndefined();
    await waitFor(() => omp.latestSession().closed);
    // The dying process cannot overwrite the outcome.
    expect(login.status().state).toBe("cancelled");
    expect(login.submitCode("abc")).toBe("not_waiting");
  });

  test("cancel with nothing running changes nothing", () => {
    const { login } = setup();
    expect(login.cancel()).toEqual({ state: "idle" });
  });

  test("a second start while one runs is refused and leaves the first alone", async () => {
    const { omp, login } = setup();
    script(omp, () => new Promise(() => undefined));

    login.start();
    expect(login.start()).toMatchObject({
      error: "already_running",
      status: { state: "running" },
    });
    await waitFor(() => omp.allSessions().length === 1);
    expect(omp.allSessions()).toHaveLength(1);
    login.cancel();
  });

  test("a new login can start after the last one ended", async () => {
    const { omp, login } = setup();
    login.start();
    await settled(login);
    expect(login.start()).toMatchObject({ error: null, status: { state: "running" } });
    await settled(login);
    expect(omp.allSessions()).toHaveLength(2);
  });

  test("OMP login errors and spawn errors fail with a typed reason", async () => {
    const { omp, login } = setup();
    script(omp, async () => {
      throw new Error("denied");
    });
    login.start();
    expect(await settled(login)).toMatchObject({ state: "failed", failure: "omp_failed" });

    omp.failNextStart(new Error("ENOENT omp"));
    login.start();
    expect(await settled(login)).toMatchObject({ state: "failed", failure: "spawn_failed" });
  });

  test("link support follows the probe and notifies listeners on change only", () => {
    const { login } = setup();
    let calls = 0;
    const off = login.onLinkSupportChange(() => (calls += 1));
    expect(login.linkSupported).toBe(false);
    login.setLinkSupported(true);
    login.setLinkSupported(true);
    expect(login.linkSupported).toBe(true);
    expect(calls).toBe(1);
    off();
    login.setLinkSupported(false);
    expect(calls).toBe(1);
  });

  test("logs never contain the URL, its query, pasted text, or codes", async () => {
    const { omp, login, lines } = setup();
    script(omp, async (s) => {
      emitOpenUrl(s);
      emitInput(s);
      await waitFor(pasteOpen(login));
      login.submitCode("http://localhost:54545/callback?code=SECRETCODE&state=OLD");
      login.submitCode("SECRETCODE#STATE1");
      await answerTo(s);
      throw new Error(`failed with ${AUTHORIZE_URL} code=SECRETCODE`);
    });
    login.start();
    await settled(login);
    const logged = lines.join("");
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [
      "SECRETCHALLENGE",
      "SECRETCODE",
      "STATE1",
      "claude.ai",
      "oauth",
      "localhost",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
