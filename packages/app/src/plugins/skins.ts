import { z } from "zod";
import type { PluginSkinContribution } from "@getpaseo/plugin/client";

const unit = z.number().finite().min(0).max(1);
const loader = z.custom<() => Promise<unknown>>((value) => typeof value === "function", {
  message: "must be a function",
});
const attributionText = z.string().trim().min(1).max(200);

const contributionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(60),
    version: z.string().min(1).max(64),
    appearance: z.enum(["light", "dark"]),
    focal: z.object({ x: unit, y: unit }).strict().optional(),
    intensity: z
      .object({ home: unit.optional(), workspace: unit.optional(), utility: unit.optional() })
      .strict()
      .optional(),
    luminance: z.object({ low: unit, high: unit }).strict().optional(),
    attribution: z
      .object({
        author: attributionText.optional(),
        license: attributionText.optional(),
        sourceUrl: attributionText
          .refine(isHttpsUrl, { message: "must be an https URL" })
          .optional(),
      })
      .strict()
      .optional(),
    loadThumbnail: loader.optional(),
    loadImage: loader,
  })
  .strict()
  .refine((value) => !value.luminance || value.luminance.low <= value.luminance.high, {
    message: "luminance.low must not exceed luminance.high",
    path: ["luminance"],
  });

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function parsePluginSkinContribution(value: unknown): PluginSkinContribution {
  return contributionSchema.parse(value) as PluginSkinContribution;
}
