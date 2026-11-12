import { getNetworkStateAsync, NetworkStateType } from "expo-network";

/** Automatic saves wait for Wi-Fi or ethernet so they never spend mobile data. */
export async function isOnUnmeteredNetwork(): Promise<boolean> {
  const { type } = await getNetworkStateAsync();
  return type === NetworkStateType.WIFI || type === NetworkStateType.ETHERNET;
}
