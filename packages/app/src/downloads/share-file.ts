import * as Sharing from "expo-sharing";
import { i18n } from "@/i18n/i18next";

/** Opens the system share sheet on a file. */
export async function shareSavedFile(
  uri: string,
  mimeType: string | null,
  fileName: string,
): Promise<void> {
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: mimeType ?? undefined,
      dialogTitle: fileName
        ? i18n.t("downloads.shareFileNamed", { fileName })
        : i18n.t("downloads.shareFile"),
    });
  }
}
