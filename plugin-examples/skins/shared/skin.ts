import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SKIN_ID = "aurora";

const SkinImageSchema = z.object({ base64: z.string(), mimeType: z.literal("image/png") });

/** The daemon generates the art, so the plugin ships no binary assets. */
export const skinImageRpc = defineRpc({
  name: "skin.image",
  input: z.object({ size: z.enum(["full", "thumbnail"]) }),
  output: SkinImageSchema,
});
