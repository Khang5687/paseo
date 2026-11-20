import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { ImageRef } from "expo-image-manipulator";
import { pathToFileUri } from "@/attachments/utils";
import { isDownscalableImageMimeType, planImageDownscale } from "@/attachments/image-downscale";
import type { DownscaleForSendInput, EncodedImage } from "@/attachments/image-codec.types";

/** iOS and Android: decode and resize the stored file with expo-image-manipulator. */
export async function downscaleAttachmentForSend(
  input: DownscaleForSendInput,
): Promise<EncodedImage> {
  const { attachment } = input;
  const keep = async (): Promise<EncodedImage> => ({
    data: await input.readBase64(),
    mimeType: attachment.mimeType,
  });
  if (
    input.sendOriginal ||
    attachment.storageType !== "native-file" ||
    !isDownscalableImageMimeType(attachment.mimeType)
  ) {
    return await keep();
  }
  const refs: { release(): void }[] = [];
  try {
    const decodeContext = ImageManipulator.manipulate(pathToFileUri(attachment.storageKey));
    refs.push(decodeContext);
    const image: ImageRef = await decodeContext.renderAsync();
    refs.push(image);
    const plan = planImageDownscale({
      width: image.width,
      height: image.height,
      mimeType: attachment.mimeType,
      sendOriginal: false,
    });
    if (plan.kind === "keep") return await keep();
    const resizeContext = ImageManipulator.manipulate(image).resize({
      width: plan.width,
      height: plan.height,
    });
    refs.push(resizeContext);
    const resized = await resizeContext.renderAsync();
    refs.push(resized);
    const result = await resized.saveAsync({
      format: SaveFormat.JPEG,
      compress: plan.quality,
      base64: true,
    });
    if (!result.base64) return await keep();
    return { data: result.base64, mimeType: plan.mimeType };
  } catch (error) {
    console.warn("[attachments] Could not resize image, sending it as is", {
      id: attachment.id,
      error,
    });
    return await keep();
  } finally {
    for (const ref of refs.toReversed()) ref.release();
  }
}
