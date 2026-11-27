import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openMobileAgentSidebar } from "../support/helpers/sidebar";

const PLUGIN_ID = "project-rail-e2e";

// A rail button with a count, one whose badge hook throws, one pointing at a screen that does
// not exist, and a header row with a badge whose label names the open workspace.
const PLUGIN_SOURCE = `import { Text, View } from "react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

function Accounts({ theme }) {
  return <View style={{ flex: 1, padding: 24 }}><Text style={{ color: theme.colors.foreground }}>Accounts screen body</Text></View>;
}

function TasksItem({ active, currentScreen, openScreen }) {
  const label = active.workspace ? "Tasks in " + active.workspace.id : "Tasks";
  return (
    <SidebarRow
      icon="ListTodo"
      label={label}
      badge={{ count: 2, tone: "attention" }}
      active={currentScreen?.screenId === "accounts"}
      onPress={() => openScreen({ screenId: "accounts" })}
    />
  );
}

function useBrokenBadge() {
  throw new Error("badge failed");
}

export default function contribute(client) {
  client.addScreen({ id: "accounts", title: "Accounts", Component: Accounts });
  client.addProjectRailItem({ id: "accounts", title: "Accounts", icon: "Gauge", screen: "accounts", useBadge: () => ({ count: 4, tone: "warning" }) });
  client.addProjectRailItem({ id: "broken", title: "Broken badge", icon: "Bug", screen: "accounts", useBadge: useBrokenBadge });
  client.addProjectRailItem({ id: "missing", title: "Missing screen", icon: "Ban", screen: "nope" });
  client.addSidebarHeaderItem({ id: "tasks", title: "Tasks", Component: TasksItem });
  return () => {};
}
`;

const RAIL_BUTTON = `plugin-project-rail-${PLUGIN_ID}-accounts`;
const TASKS_ROW = `plugin-sidebar-${PLUGIN_ID}-tasks`;

test("plugin rail buttons open their screen, badges show on the rail and the phone's icon row, and items see the open chat", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  // The rail shows with two or more projects.
  const alpha = await seedWorkspace({ repoPrefix: "plugin-rail-alpha-", title: "Alpha work" });
  const beta = await seedWorkspace({ repoPrefix: "plugin-rail-beta-", title: "Beta work" });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-project-rail-"));
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "index.client.tsx"), PLUGIN_SOURCE);
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);

    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoAppShell(page);

    await test.step("the rail shows each plugin button once, with its badge", async () => {
      const button = page.getByTestId(RAIL_BUTTON);
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute("aria-label", "Accounts, 4");
      await expect(page.getByTestId(`${RAIL_BUTTON}-badge`)).toHaveText("4");
      // A throwing badge hook leaves the button, bare; a missing screen hides the button.
      await expect(page.getByTestId(`plugin-project-rail-${PLUGIN_ID}-broken`)).toBeVisible();
      await expect(page.getByTestId(`plugin-project-rail-${PLUGIN_ID}-broken-badge`)).toHaveCount(
        0,
      );
      await expect(page.getByTestId(`plugin-project-rail-${PLUGIN_ID}-missing`)).toHaveCount(0);
    });

    await test.step("pressing it opens the screen and selects the button", async () => {
      await page.getByTestId(RAIL_BUTTON).click();
      await expect(page.getByText("Accounts screen body")).toBeVisible();
      await expect(page.getByTestId(RAIL_BUTTON)).toHaveAttribute("aria-selected", "true");
      await page.screenshot({ path: info.outputPath("desktop-rail.png") });
    });

    await test.step("the open rail writes the title beside the icon", async () => {
      await page.getByTestId("sidebar-project-rail-toggle").click();
      await expect(page.getByTestId(RAIL_BUTTON)).toContainText("Accounts");
      await page.screenshot({ path: info.outputPath("desktop-rail-open.png") });
      await page.getByTestId("sidebar-project-rail-toggle").click();
    });

    await test.step("a sidebar row badge, and the row sees the open workspace", async () => {
      const row = page.getByTestId(TASKS_ROW);
      await expect(page.getByTestId(`${TASKS_ROW}-badge`)).toHaveText("2");
      await page.getByTestId(`sidebar-workspace-row-${getServerId()}:${alpha.workspaceId}`).click();
      await expect(row).toContainText(`Tasks in ${alpha.workspaceId}`);
    });

    await test.step("the phone's icon row draws the badge on the button's corner", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openMobileAgentSidebar(page);
      const button = page.getByTestId(TASKS_ROW);
      await expect(button).toHaveAttribute("aria-label", `Tasks in ${alpha.workspaceId}, 2`);
      await expect(page.getByTestId(`${TASKS_ROW}-badge`)).toHaveText("2");
      // Phones have no rail.
      await expect(page.getByTestId(RAIL_BUTTON)).toHaveCount(0);
      await page.screenshot({ path: info.outputPath("compact-icon-row.png") });
    });
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
    await client.close();
    await rm(directory, { recursive: true, force: true });
    await alpha.cleanup();
    await beta.cleanup();
  }
});
