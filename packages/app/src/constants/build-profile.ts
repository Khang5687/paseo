import Constants from "expo-constants";

/** F-Droid build without proprietary camera or notification dependencies. */
export const isFdroidBuild = Constants.expoConfig?.extra?.fdroidBuild === true;

/** Production-like Android build with local profiling enabled. */
export const isProfileBuild = Constants.expoConfig?.extra?.profileBuild === true;

/**
 * Android build that declares `REQUEST_INSTALL_PACKAGES`, so it can open the system installer on
 * an APK. Only the fork and debug variants do; the store and F-Droid builds never ask for it.
 */
export const canInstallPackages = Constants.expoConfig?.extra?.installPackages === true;
