import { useEffect } from "react";
import { create } from "zustand";
import { z } from "zod";
import type { SkinImageUris, SkinMetadata } from "./types";

export type SkinOriginal =
  | { kind: "base64"; base64: string; mimeType: string }
  | { kind: "uri"; uri: string; mimeType?: string };

export type SkinMetadataPatch = Partial<Pick<SkinMetadata, "name" | "focal" | "appearance">>;

/** Platform storage. Implementations never validate; `createSkinCache` does. */
export interface SkinCacheBackend {
  list(): Promise<SkinMetadata[]>;
  readMetadata(id: string): Promise<SkinMetadata | null>;
  readImages(id: string): Promise<SkinImageUris | null>;
  /** Decodes, resizes and stores the images, replacing any entry with the same id. */
  write(meta: SkinMetadata, original: SkinOriginal): Promise<SkinMetadata>;
  writeMetadata(meta: SkinMetadata): Promise<void>;
  remove(id: string): Promise<void>;
}

const unit = z.number().min(0).max(1);
const focalSchema = z.strictObject({ x: unit, y: unit });
const nameSchema = z.string().trim().min(1).max(120);

export const skinMetadataSchema: z.ZodType<SkinMetadata> = z.strictObject({
  id: z.string().min(1).max(256),
  source: z.enum(["local", "plugin"]),
  version: z.string().min(1).max(64),
  name: nameSchema,
  appearance: z.enum(["light", "dark"]),
  focal: focalSchema,
  intensity: z.strictObject({ home: unit, workspace: unit, utility: unit }),
  luminance: z.strictObject({ low: unit, high: unit }).nullable(),
  attribution: z
    .strictObject({
      author: z.string().optional(),
      license: z.string().optional(),
      sourceUrl: z.string().optional(),
    })
    .nullable(),
  createdAt: z.number().finite().nonnegative(),
});

const skinMetadataPatchSchema = z.strictObject({
  name: nameSchema.optional(),
  focal: focalSchema.optional(),
  appearance: z.enum(["light", "dark"]).optional(),
});

interface SkinCacheStoreState {
  skins: SkinMetadata[] | null;
}

export interface SkinCache {
  listCachedSkins(): Promise<SkinMetadata[]>;
  readCachedSkinImages(id: string): Promise<SkinImageUris | null>;
  writeCachedSkin(meta: SkinMetadata, original: SkinOriginal): Promise<SkinMetadata>;
  deleteCachedSkin(id: string): Promise<void>;
  updateCachedSkinMetadata(id: string, patch: SkinMetadataPatch): Promise<SkinMetadata>;
  useCachedSkins(): SkinMetadata[] | null;
}

export function sortNewestFirst(skins: SkinMetadata[]): SkinMetadata[] {
  return [...skins].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function createSkinCache(backend: SkinCacheBackend): SkinCache {
  // `use` prefix: React Compiler only treats `use*` callees as hooks. Under any other name it
  // memoizes the subscription call away after the first render and breaks hook order.
  const useSkinCacheStore = create<SkinCacheStoreState>()(() => ({ skins: null }));
  let loadPromise: Promise<void> | null = null;
  let mutationTail: Promise<unknown> = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = mutationTail.then(task);
    mutationTail = run.catch(() => undefined);
    return run;
  }

  async function refresh(): Promise<SkinMetadata[]> {
    const skins = sortNewestFirst(await backend.list());
    useSkinCacheStore.setState({ skins });
    return skins;
  }

  function ensureLoaded(): Promise<void> {
    loadPromise ??= refresh().then(
      () => undefined,
      (error: unknown) => {
        console.warn("[skins] Failed to read the skin cache", error);
        useSkinCacheStore.setState({ skins: [] });
      },
    );
    return loadPromise;
  }

  async function listCachedSkins(): Promise<SkinMetadata[]> {
    await mutationTail;
    return sortNewestFirst(await backend.list());
  }

  function writeCachedSkin(meta: SkinMetadata, original: SkinOriginal): Promise<SkinMetadata> {
    const parsed = skinMetadataSchema.parse(meta);
    return serialize(async () => {
      const existing = await backend.readMetadata(parsed.id);
      const stored = await backend.write(
        { ...parsed, createdAt: existing?.createdAt ?? parsed.createdAt },
        original,
      );
      await refresh();
      return stored;
    });
  }

  function deleteCachedSkin(id: string): Promise<void> {
    return serialize(async () => {
      await backend.remove(id);
      await refresh();
    });
  }

  function updateCachedSkinMetadata(id: string, patch: SkinMetadataPatch): Promise<SkinMetadata> {
    const parsedPatch = skinMetadataPatchSchema.parse(patch);
    return serialize(async () => {
      const existing = await backend.readMetadata(id);
      if (!existing) throw new Error(`Skin ${id} is not cached on this device`);
      const next: SkinMetadata = {
        ...existing,
        ...(parsedPatch.name === undefined ? null : { name: parsedPatch.name }),
        ...(parsedPatch.focal === undefined ? null : { focal: parsedPatch.focal }),
        ...(parsedPatch.appearance === undefined ? null : { appearance: parsedPatch.appearance }),
      };
      await backend.writeMetadata(next);
      await refresh();
      return next;
    });
  }

  function useCachedSkins(): SkinMetadata[] | null {
    const skins = useSkinCacheStore((state) => state.skins);
    useEffect(() => {
      void ensureLoaded();
    }, []);
    return skins;
  }

  return {
    listCachedSkins,
    readCachedSkinImages: (id) => backend.readImages(id),
    writeCachedSkin,
    deleteCachedSkin,
    updateCachedSkinMetadata,
    useCachedSkins,
  };
}
