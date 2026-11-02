// Fork-only (Khang5687/paseo); never upstreamed. Run by scripts/fork-daemon.sh "launch".
// Starts the Mac daemon from a fork daemon release (a copy of a built Paseo.app outside
// /Applications), launched the same way the desktop app launches its own: the app's Helper as
// node, the bundled entrypoint runner, the bundled supervisor, desktop-managed. Every process the
// daemon starts (worker, terminal worker, plugins) runs from the release, so installing a new
// app bundle never replaces code under a running daemon.
//
//   ELECTRON_RUN_AS_NODE=1 "<Paseo.app>/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper" \
//     fork-daemon-launch.mjs <Paseo.app> <PASEO_HOME> <PASEO_CLI>
//
// Prints the daemon's pid and listen address; exits non-zero when it does not become ready.
import path from "node:path";
import { pathToFileURL } from "node:url";

const [appPath, home, cliPath] = process.argv.slice(2);
if (!appPath || !home || !cliPath) {
  console.error("usage: fork-daemon-launch.mjs <Paseo.app> <PASEO_HOME> <PASEO_CLI>");
  process.exit(2);
}

const resources = path.join(appPath, "Contents", "Resources");
const asar = path.join(resources, "app.asar");
const helper = path.join(
  appPath,
  "Contents",
  "Frameworks",
  "Paseo Helper.app",
  "Contents",
  "MacOS",
  "Paseo Helper",
);
const runner = path.join(
  resources,
  "app.asar.unpacked",
  "dist",
  "daemon",
  "node-entrypoint-runner.js",
);
const server = path.join(asar, "node_modules", "@getpaseo", "server", "dist");
const supervisor = path.join(server, "scripts", "supervisor-entrypoint.js");

// The caller's environment (a terminal, or the desktop app's login-shell environment) reaches the
// daemon and its agents, as it does for a desktop launch. Paseo variables of the shell this was
// started from (Paseo terminals and agents set PASEO_AGENT_ID, PASEO_CLI, ...) must not leak into
// the daemon; startDaemonInstance sets PASEO_HOME and the desktop-managed flag itself.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
);
env.ELECTRON_RUN_AS_NODE = "1";
env.PASEO_NODE_ENV = "production";
env.PASEO_CLI = cliPath;

const { startDaemonInstance } = await import(
  pathToFileURL(path.join(server, "server", "server", "daemon-instance.js")).href
);
try {
  const { instance, spawned } = await startDaemonInstance({
    home,
    command: helper,
    args: ["--disable-warning=DEP0040", runner, "node-script", supervisor],
    env,
    mode: "managed",
    desktopManaged: true,
    timeoutMs: 60_000,
  });
  console.log(
    `${spawned ? "started" : "already running"}: pid ${instance.pid}, listen ${instance.listen ?? "?"}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
