import { z } from "zod";

// Copies of files that agents on another host mentioned. The host that ran the agent (the
// source) pushes them to an always-on host (the target), so a client can open them while the
// source sleeps. Gate every request on `server_info.features.fileCopies`.

export const FileCopyEntrySchema = z.object({
  // The host the file lives on and its absolute path there.
  sourceServerId: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  // The source file's own mtime and revision when the copy was taken.
  modifiedAt: z.string(),
  revision: z.string(),
  savedAt: z.string(),
  lastMentionedAt: z.string(),
});

export const FileCopySettingsSchema = z.object({
  // Where this host pushes copies of files its agents mention. Null: it pushes nowhere.
  targetServerId: z.string().nullable(),
  // Copies not mentioned for this many days are removed.
  keepDays: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
});

export const FileCopyUsageSchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
});

/** Sent by a source host: the files a turn mentioned. Unchanged copies count as mentioned again. */
export const FileCopiesRecordMentionsRequestSchema = z.object({
  type: z.literal("files.copies.record_mentions.request"),
  requestId: z.string(),
  // The source host's home directory, so `~/x` reads resolve to the stored absolute path.
  sourceHome: z.string(),
  files: z.array(z.object({ path: z.string(), revision: z.string() })),
});

/** Sent by a source host after `file.upload.request` stored the bytes on this host. */
export const FileCopiesPutRequestSchema = z.object({
  type: z.literal("files.copies.put.request"),
  requestId: z.string(),
  uploadId: z.string(),
  sourceHome: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  modifiedAt: z.string(),
  revision: z.string(),
});

/** Streams the bytes as file-transfer frames on the request id, then the response. */
export const FileCopiesReadRequestSchema = z.object({
  type: z.literal("files.copies.read.request"),
  requestId: z.string(),
  sourceServerId: z.string(),
  // Absolute on the source host, or `~/…` against the source's home directory.
  path: z.string(),
});

export const FileCopiesListRequestSchema = z.object({
  type: z.literal("files.copies.list.request"),
  requestId: z.string(),
  sourceServerId: z.string().optional(),
  // Case-insensitive substring of the path.
  query: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const FileCopiesRemoveRequestSchema = z.object({
  type: z.literal("files.copies.remove.request"),
  requestId: z.string(),
  sourceServerId: z.string(),
  path: z.string(),
});

export const FileCopiesGetSettingsRequestSchema = z.object({
  type: z.literal("files.copies.get_settings.request"),
  requestId: z.string(),
});

export const FileCopiesUpdateSettingsRequestSchema = z.object({
  type: z.literal("files.copies.update_settings.request"),
  requestId: z.string(),
  targetServerId: z.string().nullable().optional(),
  keepDays: z.number().int().positive().optional(),
  maxTotalBytes: z.number().int().positive().optional(),
  maxFileBytes: z.number().int().positive().optional(),
});

export const FileCopiesRecordMentionsResponseSchema = z.object({
  type: z.literal("files.copies.record_mentions.response"),
  payload: z.object({
    requestId: z.string(),
    // Paths this host has no copy of at the sent revision; the source uploads these.
    needed: z.array(z.string()),
    error: z.string().nullable(),
  }),
});

export const FileCopiesPutResponseSchema = z.object({
  type: z.literal("files.copies.put.response"),
  payload: z.object({
    requestId: z.string(),
    entry: FileCopyEntrySchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const FileCopiesReadResponseSchema = z.object({
  type: z.literal("files.copies.read.response"),
  payload: z.object({
    requestId: z.string(),
    entry: FileCopyEntrySchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const FileCopiesListResponseSchema = z.object({
  type: z.literal("files.copies.list.response"),
  payload: z.object({
    requestId: z.string(),
    entries: z.array(FileCopyEntrySchema),
    usage: FileCopyUsageSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const FileCopiesRemoveResponseSchema = z.object({
  type: z.literal("files.copies.remove.response"),
  payload: z.object({
    requestId: z.string(),
    removed: z.boolean(),
    error: z.string().nullable(),
  }),
});

const FileCopiesSettingsPayloadSchema = z.object({
  requestId: z.string(),
  settings: FileCopySettingsSchema.nullable(),
  usage: FileCopyUsageSchema.nullable(),
  error: z.string().nullable(),
});

export const FileCopiesGetSettingsResponseSchema = z.object({
  type: z.literal("files.copies.get_settings.response"),
  payload: FileCopiesSettingsPayloadSchema,
});

export const FileCopiesUpdateSettingsResponseSchema = z.object({
  type: z.literal("files.copies.update_settings.response"),
  payload: FileCopiesSettingsPayloadSchema,
});

export type FileCopyEntry = z.infer<typeof FileCopyEntrySchema>;
export type FileCopySettings = z.infer<typeof FileCopySettingsSchema>;
export type FileCopyUsage = z.infer<typeof FileCopyUsageSchema>;
export type FileCopiesUpdateSettingsRequest = z.infer<typeof FileCopiesUpdateSettingsRequestSchema>;
