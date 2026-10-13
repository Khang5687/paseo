import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import {
  expectRoutingLoaded,
  installRoutingGate,
  routingRow,
  routingSection,
  startRoutingFixtureHost,
  type RoutingFixtureHost,
} from "../support/helpers/account-routing";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { TEST_HOST_LABEL } from "../support/helpers/daemon-registry";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { getServerId } from "../support/helpers/server-id";
import {
  expectSettingsHeader,
  openSettingsHost,
  openHostSection,
  openCompactSettings,
  expectHostLabelDisplayed,
  clickEditHostLabel,
  expectHostLabelEditMode,
  expectHostConnectionsCard,
  expectHostInjectMcpCard,
  expectHostActionCards,
  expectHostProvidersCard,
  expectHostNoDaemonLifecycleRow,
  expectRetiredSidebarSectionsAbsent,
  expectHostPageVisible,
  seedSavedSettingsHosts,
  selectSettingsHost,
  expectHostRejectedWithReAddGuidance,
  expectNoHostPasswordControls,
  removeHostFromHostPage,
  addDirectHostFromSettings,
  expectHostOnlineWithoutError,
} from "../support/helpers/settings";

test.describe("Settings host page", () => {
  test("visits host settings and opens the label editor", async ({ page }) => {
    const serverId = getServerId();
    const port = getE2EDaemonPort();
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);
    await test.step("connections section shows the seeded connection endpoint", async () => {
      await expectSettingsHeader(page, "Connections");
      await expectHostConnectionsCard(page, port);
    });
    await test.step("agents section shows the inject MCP toggle", async () => {
      await openHostSection(page, serverId, "agents");
      await expectSettingsHeader(page, "Agents");
      await expectHostInjectMcpCard(page);
    });
    await test.step("providers section shows the providers card", async () => {
      await expectHostProvidersCard(page, serverId);
      await expectSettingsHeader(page, "Providers");
    });
    await test.step("host section shows the host label and restart/remove action cards", async () => {
      await openHostSection(page, serverId, "host");
      await expectSettingsHeader(page, "Overview");
      await expectHostLabelDisplayed(page);
      await expectHostActionCards(page, serverId);
    });
    await test.step("clicking the label pencil reveals the inline editor", async () => {
      await openHostSection(page, serverId, "host");

      await expectHostLabelDisplayed(page);
      await clickEditHostLabel(page);
      await expectHostLabelEditMode(page, TEST_HOST_LABEL);
      await page.keyboard.press("Escape");
    });
    await test.step("host section does not render daemon lifecycle controls for a remote daemon", async () => {
      await openHostSection(page, serverId, "host");

      await expectHostNoDaemonLifecycleRow(page);
    });
    await test.step("settings sidebar exposes the flat App and Host section rows", async () => {
      await expectRetiredSidebarSectionsAbsent(page);
    });
  });

  test("a failed remote daemon update remains visible in the host UI", async ({
    page,
    outdatedDaemon,
  }) => {
    await seedSavedSettingsHosts(page, [outdatedDaemon]);
    await page.reload();
    await openSettings(page);
    await openSettingsHost(page, outdatedDaemon.serverId);
    await openHostSection(page, outdatedDaemon.serverId, "host");

    page.once("dialog", (dialog) => dialog.accept());
    const updateButton = page.getByTestId("host-page-update-button");
    await updateButton.click();

    await expect(
      updateButton.filter({ hasText: /Preparing update|Downloading packages|Installing/ }),
    ).toBeDisabled();

    const updateFailure = page.getByTestId("host-page-update-error");
    await expect(updateFailure).toBeVisible();
    await expect(updateFailure).toContainText("Update failed");
    await expect(updateFailure).toContainText("Failed to update the daemon:");
    await expect(updateButton).toBeEnabled();
  });

  test("a host rejected for its password reconnects after being removed and added again with it", async ({
    page,
  }) => {
    const password = "e2e host password";
    const daemon = await startIsolatedHostDaemon("srv_e2e_password_host", {
      environment: { ...process.env, PASEO_PASSWORD: password },
    });
    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: TEST_HOST_LABEL,
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: daemon.serverId,
          label: "Password host",
          endpoint: `127.0.0.1:${daemon.port}`,
        },
      ]);
      await page.reload();
      await openSettings(page);
      await selectSettingsHost(page, daemon.serverId);
      await openHostSection(page, daemon.serverId, "host");

      await test.step("the host page shows the reason and the re-add guidance, with no password UI", async () => {
        await expectHostRejectedWithReAddGuidance(page, "Password required");
        await expectNoHostPasswordControls(page);
      });

      await test.step("removing the host and adding it again with the password brings it online", async () => {
        await removeHostFromHostPage(page, daemon.serverId);
        await addDirectHostFromSettings(page, { host: "127.0.0.1", port: daemon.port, password });
        await openHostSection(page, daemon.serverId, "host");
        await expectHostOnlineWithoutError(page);
      });
    } finally {
      await daemon.close();
    }
  });

  test("navigating to /settings/hosts/[serverId] redirects to the connections section", async ({
    page,
  }) => {
    const serverId = getServerId();

    await gotoAppShell(page);
    await page.goto(`/settings/hosts/${encodeURIComponent(serverId)}`);

    await expectHostPageVisible(page, serverId);
    await expectSettingsHeader(page, "Connections");
    await openHostSection(page, serverId, "host");
    await expectHostLabelDisplayed(page);
    await expectHostActionCards(page, serverId);
  });
});

/** Makes the page look like the desktop app whose built-in daemon is `serverId`. */
async function installDesktopOnHost(page: Page, serverId: string): Promise<void> {
  await page.addInitScript((localServerId) => {
    (window as unknown as { paseoDesktop: unknown }).paseoDesktop = {
      platform: "darwin",
      invoke: async (command: string) => {
        if (command === "desktop_daemon_status") {
          return {
            serverId: localServerId,
            status: "running",
            listen: null,
            hostname: null,
            pid: null,
            home: "",
            version: null,
            desktopManaged: true,
            error: null,
          };
        }
        if (command === "get_desktop_settings") {
          return {
            releaseChannel: "stable",
            daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
          };
        }
        return null;
      },
      getPendingOpenProject: async () => null,
      events: { on: async () => () => undefined },
    };
  }, serverId);
}

async function openRoutingSection(
  page: Page,
  host: RoutingFixtureHost,
  options: { compact: boolean; readOnly?: boolean; desktopOnHost?: boolean },
) {
  await gotoAppShell(page);
  const gate = await installRoutingGate(page, host.port, { readOnly: options.readOnly });
  if (options.desktopOnHost) await installDesktopOnHost(page, host.serverId);
  await addConnectedHostAndReload(page, {
    serverId: host.serverId,
    label: "Routing host",
    port: host.port,
  });
  if (options.compact) {
    await openCompactSettings(page, buildOpenProjectRoute());
  } else {
    await openSettings(page);
  }
  await selectSettingsHost(page, host.serverId);
  await openHostSection(page, host.serverId, "providers");
  await expectRoutingLoaded(page);
  await routingSection(page).scrollIntoViewIfNeeded();
  return gate;
}

async function shot(page: Page, name: string): Promise<void> {
  // Start at the section title so the notices above the controls are in frame.
  await routingSection(page).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: `../../.scratch/routing-${name}.png` });
}

for (const layout of [
  { name: "compact", compact: true, viewport: { width: 390, height: 844 } },
  { name: "desktop", compact: false, viewport: { width: 1280, height: 860 } },
]) {
  test.describe(`Settings host providers: OMP account routing (${layout.name})`, () => {
    test.use({ viewport: layout.viewport });

    test("selects, toggles, excludes and reorders without coupling the controls", async ({
      page,
    }) => {
      test.setTimeout(240_000);
      const host = await startRoutingFixtureHost();
      try {
        const gate = await openRoutingSection(page, host, layout);
        const auto = page.getByRole("switch", { name: "Auto-routing", exact: true });
        const rows = page.locator('[data-testid^="omp-routing-row-"]');

        await test.step("loaded: three accounts, duplicate email told apart, billing refusal explained", async () => {
          await expect(rows).toHaveCount(3);
          await expect(routingRow(page, "acct-2")).toContainText("North Co");
          await expect(routingRow(page, "acct-3")).toContainText("South Co");
          await expect(routingRow(page, "acct-3")).toContainText("Paid usage credits are enabled");
          await expect(routingRow(page, "ada@example.test")).toContainText("40% used");
          await expect(routingRow(page, "acct-2")).toContainText("100% used");
          await expect(routingRow(page, "ada@example.test")).toContainText(
            "Weekly (Sonnet): 20% used",
          );
          await expect(routingRow(page, "ada@example.test")).not.toContainText("remaining");
          await expect(page.getByTestId("omp-routing-summary")).toHaveText(
            "Auto picks the account with the most usage left",
          );
          await expect(page.getByTestId("omp-routing-account-trigger")).toContainText("Automatic");
          await expect(page.getByTestId("omp-routing-add-hint")).toContainText("/login");
          // A browser or phone cannot sign in on the host's behalf: it points at the host computer.
          await expect(page.getByTestId("omp-routing-add-elsewhere")).toHaveText(
            "Open Paseo on the host computer to add an account.",
          );
          await expect(page.getByTestId("omp-routing-add-button")).toHaveCount(0);
          await shot(page, `${layout.name}-loaded`);
          await page.getByTestId("omp-routing-add-elsewhere").scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `../../.scratch/routing-${layout.name}-add-elsewhere.png`,
          });
        });

        await test.step("selecting an account changes only the current account", async () => {
          await page.getByTestId("omp-routing-account-trigger").click();
          await page.getByPlaceholder("Search accounts").fill("ada");
          await page.getByText("Atlas Labs", { exact: true }).last().click();
          await expect(routingRow(page, "ada@example.test")).toContainText("Selected");
          await expect(auto).toBeChecked();
          await expect(page.getByTestId("omp-routing-summary")).toHaveText(
            "Using ada@example.test",
          );
          await shot(page, `${layout.name}-selected`);
        });

        await test.step("auto-routing switch changes only auto", async () => {
          await auto.click();
          await expect(auto).not.toBeChecked();
          await expect(routingRow(page, "ada@example.test")).toContainText("Selected");
          await auto.click();
          await expect(auto).toBeChecked();
        });

        await test.step("excluding an account does not select or disable auto, and excluding current keeps it selected", async () => {
          await page.getByRole("switch", { name: "Use for auto-routing: acct-2" }).click();
          await expect(routingRow(page, "acct-2")).toContainText("Excluded from auto-routing");
          await page
            .getByRole("switch", { name: "Use for auto-routing: ada@example.test" })
            .click();
          await expect(routingRow(page, "ada@example.test")).toContainText(
            "Excluded from auto-routing",
          );
          await expect(routingRow(page, "ada@example.test")).toContainText("Selected");
          await page
            .getByRole("switch", { name: "Use for auto-routing: ada@example.test" })
            .click();
          await expect(auto).toBeChecked();
          await shot(page, `${layout.name}-excluded`);
        });

        await test.step("priority moves reorder only; keyboard activates them", async () => {
          const up = page.getByRole("button", { name: "Move up: acct-3" });
          await up.focus();
          await page.keyboard.press("Enter");
          await expect(rows.nth(1)).toContainText("acct-3");
          await expect(routingRow(page, "ada@example.test")).toContainText("Selected");
          await expect(routingRow(page, "acct-3")).not.toContainText("Selected");
          await shot(page, `${layout.name}-reordered`);
        });

        await test.step("a request being served is attributed to the serving account", async () => {
          expect((await host.run({ op: "serve" })).decision).toMatchObject({ kind: "admit" });
          await expect(routingRow(page, "ada@example.test")).toContainText("Serving");
          await expect(routingRow(page, "ada@example.test")).toContainText("is serving");
          await shot(page, `${layout.name}-serving`);
        });

        await test.step("quota pause and recovery", async () => {
          await host.run({ op: "pause" });
          await expect(page.getByTestId("omp-routing-notice-paused")).toBeVisible();
          await expect(routingRow(page, "acct-2")).toContainText("5-hour limit reached · resets");
          await shot(page, `${layout.name}-paused`);
          await host.run({ op: "recover" });
          await expect(page.getByTestId("omp-routing-notice-recovered")).toBeVisible();
          await shot(page, `${layout.name}-recovered`);
        });

        await test.step("a stale revision shows the host's state and the conflict", async () => {
          gate.hold();
          await host.run({ op: "mutate", command: { kind: "set_auto", enabled: false } });
          await page.getByRole("switch", { name: "Use for auto-routing: acct-2" }).click();
          await expect(page.getByTestId("omp-routing-notice-conflict")).toBeVisible();
          await expect(auto).not.toBeChecked();
          await shot(page, `${layout.name}-conflict`);
          gate.release();
        });

        await test.step("withdrawn host support keeps the section with controls disabled", async () => {
          await host.run({ op: "archive-agent" });
          await expect(page.getByTestId("omp-routing-notice-unsupported")).toBeVisible();
          await expect(auto).toBeDisabled();
          await shot(page, `${layout.name}-unsupported`);
        });
      } finally {
        await host.close();
      }
    });
  });
}

test.describe("Settings host providers: OMP account routing with one exhausted account", () => {
  for (const layout of [
    { name: "compact", compact: true, viewport: { width: 390, height: 844 } },
    { name: "desktop", compact: false, viewport: { width: 1280, height: 860 } },
  ]) {
    test(`explains a used-up weekly limit plainly (${layout.name})`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(layout.viewport);
      const host = await startRoutingFixtureHost({ scenario: "exhausted" });
      try {
        await openRoutingSection(page, host, layout);
        const row = page.locator('[data-testid^="omp-routing-row-"]');
        await expect(page.getByTestId("omp-routing-summary")).toContainText(
          "Paused: no included account has usage left. Resumes",
        );
        await expect(page.getByTestId("omp-routing-account-trigger")).toContainText("Automatic");
        await expect(row).toContainText("Weekly limit reached · resets");
        await expect(row).toContainText("5-hour: 0% used");
        await expect(row).toContainText("Weekly: 100% used · resets");
        await expect(row).toContainText("Weekly (Fable): 100% used");
        await expect(row).toContainText("Use for auto-routing");
        await expect(row).not.toContainText("Organization");
        await expect(row).not.toContainText("remaining");
        await expect(row).not.toContainText("Observed");
        await expect(row).not.toContainText("Priority");
        await expect(page.locator('[data-testid^="omp-routing-up-"]')).toHaveCount(0);
        await expect(page.getByTestId("omp-routing-add-hint")).toBeVisible();
        await shot(page, `${layout.name}-exhausted`);
      } finally {
        await host.close();
      }
    });
  }
});

for (const layout of [
  { name: "compact", compact: true, viewport: { width: 390, height: 844 } },
  { name: "desktop", compact: false, viewport: { width: 1280, height: 860 } },
]) {
  test.describe(`Settings host providers: add Claude account (${layout.name})`, () => {
    test.use({ viewport: layout.viewport });

    test("with no agent running the section shows its controls and the Add button", async ({
      page,
    }) => {
      test.setTimeout(240_000);
      const host = await startRoutingFixtureHost({ agent: false });
      try {
        await openRoutingSection(page, host, { ...layout, desktopOnHost: true });
        await expect(page.getByTestId("omp-routing-no-runtime")).toHaveText(
          "Accounts appear when an Oh My Pi agent is running.",
        );
        await expect(page.getByRole("switch", { name: "Auto-routing", exact: true })).toBeEnabled();
        await expect(page.locator('[data-testid^="omp-routing-row-"]')).toHaveCount(0);
        await expect(page.getByTestId("omp-routing-add-button")).toBeVisible();
        await shot(page, `${layout.name}-no-runtime`);
      } finally {
        await host.close();
      }
    });

    test("the desktop app on the host's computer starts, cancels, and finishes a sign-in", async ({
      page,
    }) => {
      test.setTimeout(240_000);
      const host = await startRoutingFixtureHost();
      try {
        await openRoutingSection(page, host, { ...layout, desktopOnHost: true });
        const button = page.getByTestId("omp-routing-add-button");
        await expect(button).toBeVisible();
        await expect(page.getByTestId("omp-routing-add-elsewhere")).toHaveCount(0);
        await expect(page.getByTestId("omp-routing-add-account")).toContainText(
          "Sign in with a Claude account that is not listed here. Signing in with a listed account replaces its saved login.",
        );
        await button.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../../.scratch/routing-${layout.name}-add-account.png` });

        await button.click();
        await expect(page.getByTestId("omp-routing-add-account")).toContainText(
          "Finish signing in in your browser",
        );
        await page.getByTestId("omp-routing-add-cancel").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../../.scratch/routing-${layout.name}-add-running.png` });
        await page.getByTestId("omp-routing-add-cancel").click();
        await expect(page.getByTestId("omp-routing-add-result")).toHaveText("Sign-in cancelled.");

        await page.getByTestId("omp-routing-add-button").click();
        await expect(page.getByTestId("omp-routing-add-result")).toContainText("Account saved.", {
          timeout: 15_000,
        });
        await expect(page.getByTestId("omp-routing-add-result")).toContainText(
          "Turn off paid extra usage",
        );
        await page.getByTestId("omp-routing-add-result").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../../.scratch/routing-${layout.name}-add-saved.png` });
      } finally {
        await host.close();
      }
    });
  });
}

test.describe("Settings host providers: OMP account routing read-only and offline", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a host without manage permission is read-only", async ({ page }) => {
    test.setTimeout(180_000);
    const host = await startRoutingFixtureHost();
    try {
      await openRoutingSection(page, host, { compact: true, readOnly: true });
      await expect(page.getByTestId("omp-routing-notice-readOnly")).toBeVisible();
      await expect(page.getByRole("switch", { name: "Auto-routing", exact: true })).toBeDisabled();
      await shot(page, "compact-read-only");
    } finally {
      await host.close();
    }
  });

  test("an offline host keeps its last confirmed settings, disabled", async ({ page }) => {
    test.setTimeout(180_000);
    const host = await startRoutingFixtureHost();
    try {
      await openRoutingSection(page, host, { compact: true });
      await host.close();
      await expect(page.getByTestId("omp-routing-notice-offline")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("switch", { name: "Auto-routing", exact: true })).toBeDisabled();
      await expect(page.locator('[data-testid^="omp-routing-row-"]')).not.toHaveCount(0);
      await shot(page, "compact-offline");
    } finally {
      await host.close();
    }
  });
});
