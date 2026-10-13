import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { FakeOmp, type FakeOmpSession } from "../agent/providers/omp/test-utils/fake-omp.js";
import { OmpAccountLogin } from "./login.js";

const AUTHORIZE_URL =
  "https://claude.ai/oauth/authorize?client_id=x&code_challenge=SECRETCHALLENGE";

function setup(options: { timeoutMs?: number; openUrl?: (url: string) => Promise<void> } = {}) {
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
  const opened: string[] = [];
  const login = new OmpAccountLogin({
    runtime: omp,
    logger,
    timeoutMs: options.timeoutMs,
    openUrl:
      options.openUrl ??
      (async (url) => {
        opened.push(url);
      }),
  });
  return { omp, login, opened, lines };
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
const uiCancelled = (session: FakeOmpSession, id: string) => () =>
  session.canceledExtensionUiRequests.includes(id);

function script(omp: FakeOmp, handler: (session: FakeOmpSession) => Promise<void>) {
  omp.queueSessionSetup((session) => {
    session.loginHandler = handler;
  });
}

const emitOpenUrl = (session: FakeOmpSession, url = AUTHORIZE_URL) =>
  session.emit({ type: "extension_ui_request", id: "ui-1", method: "open_url", url });

describe("OmpAccountLogin", () => {
  test("opens the authorize URL on the host and reports success", async () => {
    const { omp, login, opened } = setup();
    script(omp, async (s) => emitOpenUrl(s));

    expect(login.status()).toEqual({ state: "idle" });
    expect(login.start()).toMatchObject({ error: null, status: { state: "running" } });
    expect(await settled(login)).toMatchObject({ state: "succeeded" });

    expect(opened).toEqual([AUTHORIZE_URL]);
    const session = omp.latestSession();
    expect(session.loginRequests).toEqual(["anthropic"]);
    await waitFor(() => session.closed);
    // Plain OMP: no routing, no session file, no prompt.
    expect(omp.recordedLaunches[0]).toMatchObject({ noSession: true, protocolMode: "rpc" });
    expect(session.prompts).toEqual([]);
  });

  test("a paste-code request is cancelled and reported as a failure", async () => {
    const { omp, login } = setup();
    script(omp, async (s) => {
      emitOpenUrl(s);
      s.emit({ type: "extension_ui_request", id: "ui-2", method: "input", title: "Paste code" });
      await waitFor(uiCancelled(s, "ui-2"));
      throw new Error("Login cancelled");
    });

    login.start();
    expect(await settled(login)).toMatchObject({
      state: "failed",
      failure: "paste_code_unsupported",
    });
    expect(omp.latestSession().canceledExtensionUiRequests).toEqual(["ui-2"]);
    await waitFor(() => omp.latestSession().closed);
  });

  test("a login that never finishes times out and kills the process", async () => {
    const { omp, login } = setup({ timeoutMs: 30 });
    script(omp, () => new Promise(() => undefined));

    login.start();
    expect(await settled(login)).toMatchObject({ state: "failed", failure: "timeout" });
    await waitFor(() => omp.latestSession().closed);
  });

  test("cancel stops a running login", async () => {
    const { omp, login } = setup();
    script(omp, () => new Promise(() => undefined));

    login.start();
    await waitFor(() => omp.allSessions().length === 1);
    expect(login.cancel()).toMatchObject({ state: "cancelled" });
    await waitFor(() => omp.latestSession().closed);
    // The dying process cannot overwrite the outcome.
    expect(login.status().state).toBe("cancelled");
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

  test("a URL that is not https is never opened", async () => {
    const { omp, login, opened } = setup();
    script(omp, async (s) => {
      emitOpenUrl(s, "file:///etc/passwd");
      await waitFor(ended(login));
    });
    login.start();
    expect(await settled(login)).toMatchObject({ failure: "browser_open_failed" });
    expect(opened).toEqual([]);
  });

  test("a failing opener fails the login", async () => {
    const { omp, login } = setup({
      openUrl: async () => {
        throw new Error("no browser");
      },
    });
    script(omp, async (s) => {
      emitOpenUrl(s);
      await waitFor(ended(login));
    });
    login.start();
    expect(await settled(login)).toMatchObject({ failure: "browser_open_failed" });
  });

  test("logs never contain the URL, its query, or codes", async () => {
    const { omp, login, lines } = setup();
    script(omp, async (s) => {
      emitOpenUrl(s);
      s.emit({ type: "extension_ui_request", id: "ui-2", method: "input" });
      throw new Error(`failed with ${AUTHORIZE_URL} code=SECRETCODE`);
    });
    login.start();
    await settled(login);
    const logged = lines.join("");
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of ["SECRETCHALLENGE", "SECRETCODE", "claude.ai", "oauth"]) {
      expect(logged).not.toContain(secret);
    }
  });
});
