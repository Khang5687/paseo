/**
 * Automatic saves wait for Wi-Fi or ethernet. Browsers that do not report the connection type
 * (desktop browsers, Electron) count as unmetered; automatic saving is off there by default.
 */
export async function isOnUnmeteredNetwork(): Promise<boolean> {
  const type = (navigator as Navigator & { connection?: { type?: string } }).connection?.type;
  return type === undefined || type === "wifi" || type === "ethernet";
}
