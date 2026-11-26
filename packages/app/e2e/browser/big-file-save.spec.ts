import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test as baseTest } from "../support/fixtures";
import { clickSessionRow, openSessions } from "../support/helpers/archive-tab";
import { addConnectedHostAndReload, waitForConnectedHost } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { seedWorkspace } from "../support/helpers/seed-client";

// A 300 MB file saved on purpose goes to the phone as it arrives. The browser's memory stays far
// below the file size, the toast shows progress, and the file opens from Saved with the host gone.
//
// The browser runs with a profile on disk, like a real one. Playwright's default profile is in
// memory, and a browser keeps IndexedDB and the private file system there in memory too, which
// would count the saved file as memory use.
const test = baseTest.extend({
  context: async ({ playwright, baseURL }, provide) => {
    const profile = await mkdtemp(path.join(tmpdir(), "paseo-big-file-profile-"));
    const context = await playwright.chromium.launchPersistentContext(profile, {
      baseURL,
      hasTouch: true,
    });
    try {
      await provide(context);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
});

const MB = 1024 * 1024;
const FILE_MB = 300;
const FILE = "media/bigclip.bin";

async function writeBigFile(target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const handle = await open(target, "w");
  try {
    const block = randomBytes(MB);
    for (let written = 0; written < FILE_MB; written += 1) {
      await handle.write(block);
    }
  } finally {
    await handle.close();
  }
}

interface MemorySample {
  rssMb: number;
  rendererMb: number;
  browserMb: number;
  jsHeapMb: number;
}

/** Resident memory of every process under this worker's Chromium, split by process type. */
function browserProcessesMb(): { rendererMb: number; browserMb: number; rssMb: number } {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      args: match[4] ?? "",
    }));
  const roots = rows.filter(
    (row) => row.ppid === process.pid && row.args.includes("--remote-debugging-pipe"),
  );
  const tree = new Set(roots.map((row) => row.pid));
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }
  const members = rows.filter((row) => tree.has(row.pid));
  const mb = (list: typeof members) => list.reduce((sum, row) => sum + row.rssKb, 0) / 1024;
  return {
    rssMb: mb(members),
    rendererMb: mb(members.filter((row) => row.args.includes("--type=renderer"))),
    browserMb: mb(members.filter((row) => !row.args.includes("--type="))),
  };
}

/** Samples the browser's memory every 200 ms and keeps the peak. */
async function startMemoryProbe(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const sample = async (): Promise<MemorySample> => {
    const { metrics } = await session.send("Performance.getMetrics");
    const heap = metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0;
    const processes = browserProcessesMb();
    return {
      rssMb: Math.round(processes.rssMb),
      rendererMb: Math.round(processes.rendererMb),
      browserMb: Math.round(processes.browserMb),
      jsHeapMb: Math.round(heap / MB),
    };
  };
  let peak = await sample();
  const stopped = new AbortController();
  const loop = (async () => {
    while (!stopped.signal.aborted) {
      const current = await sample();
      if (current.rssMb > peak.rssMb) peak = current;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();
  return {
    sample,
    async stop(): Promise<MemorySample> {
      stopped.abort();
      await loop;
      await session.detach();
      return peak;
    },
  };
}

async function longPress(page: Page, text: string) {
  const link = page.getByText(text, { exact: true });
  await expect(link).toBeVisible({ timeout: 60_000 });
  await link.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 2,
      }),
    );
  });
}

test.describe("Big files", () => {
  test.describe.configure({ timeout: 600_000 });

  test("a 300 MB file saved offline streams in with flat memory and opens with no network", async ({
    page,
  }) => {
    const mac = await startIsolatedHostDaemon(
      `srv_mac_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    );
    const workspace = await seedWorkspace({ repoPrefix: "big-file-", port: mac.port });
    try {
      await writeBigFile(path.join(workspace.repoPath, FILE));
      await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Big file",
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "Where is the clip?",
        featureValues: { mockAssistantResponse: `The clip is in \`${FILE}\`.` },
      });

      await page.goto("/");
      await addConnectedHostAndReload(page, {
        serverId: mac.serverId,
        label: "Mac box",
        port: mac.port,
        primaryLabel: "Omen box",
      });
      await waitForConnectedHost(page, {
        serverId: mac.serverId,
        endpoint: `localhost:${mac.port}`,
      });
      await openSessions(page);
      await clickSessionRow(page, "Big file");
      await page.setViewportSize({ width: 390, height: 844 });

      await longPress(page, FILE);
      const probe = await startMemoryProbe(page);
      const baseline = await probe.sample();
      const save = page.getByTestId("file-link-save-offline");
      await expect(save).toBeVisible();
      await save.tap();

      // The toast tracks the transfer while it runs. The menu sheet slides away first.
      const toast = page.getByText("bigclip.bin", { exact: true });
      await expect(toast).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("file-path-menu-content")).toBeHidden();
      await expect(page.getByText(/^\d+% · /).first()).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: test.info().outputPath("big-file-progress.png") });

      await expect(toast).toBeHidden({ timeout: 300_000 });
      // Give the browser time to let go of what it only needed during the transfer.
      await page.waitForTimeout(6_000);
      const settled = await probe.sample();
      const peak = await probe.stop();
      const memory = {
        fileMb: FILE_MB,
        baseline,
        peak,
        settled,
        growthRssMb: peak.rssMb - baseline.rssMb,
        settledGrowthRssMb: settled.rssMb - baseline.rssMb,
        growthJsHeapMb: peak.jsHeapMb - baseline.jsHeapMb,
      };
      console.log(`BIG_FILE_MEMORY ${JSON.stringify(memory)}`);
      await test.info().attach("memory.json", {
        body: JSON.stringify(memory, null, 2),
        contentType: "application/json",
      });
      // The old code held the file at least twice. Streaming must stay well under one copy.
      expect(memory.growthRssMb).toBeLessThan(FILE_MB * 0.6);
      expect(memory.growthJsHeapMb).toBeLessThan(FILE_MB / 4);

      // The host goes to sleep and the phone loses signal.
      await mac.close();
      await page.context().setOffline(true);

      await page.getByRole("button", { name: "Open menu", exact: true }).first().tap();
      const row = page.locator('[data-testid="sidebar-saved"]:visible').first();
      await expect(row).toContainText("Saved on this device");
      await expect(row).toBeInViewport({ ratio: 1 });
      await row.tap();

      const library = page.getByTestId("saved-library");
      const group = library.getByTestId(`offline-files-host-${mac.serverId}`);
      await expect(group.getByText("bigclip.bin", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(group.getByText("300.0 MB").first()).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("big-file-saved-list.png") });

      await group.getByTestId("offline-files-row").tap();
      const viewer = page.getByTestId("saved-file-screen");
      await expect(viewer.getByTestId("offline-file-bar")).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: test.info().outputPath("big-file-saved-offline.png") });
    } finally {
      await page.context().setOffline(false);
      await workspace.cleanup();
      await mac.close();
    }
  });
});
