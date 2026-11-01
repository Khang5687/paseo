import { z } from "zod";

// Where the highlighted text came from. The note keeps its own copy of the text (`quote`), so the
// anchor only has to be good enough to jump back; it may point at text that was since trimmed.
export const NoteAnchorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    agentId: z.string(),
    workspaceId: z.string().optional(),
    // Stream row identity (`data-history-row-id`) and the provider message id when known.
    rowId: z.string().optional(),
    messageId: z.string().optional(),
    role: z.enum(["user", "assistant"]).optional(),
    // Character offsets of the selection inside the rendered message text.
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("terminal"),
    terminalId: z.string(),
    workspaceId: z.string().optional(),
    cwd: z.string().optional(),
    terminalName: z.string().optional(),
    startLine: z.number().int().nonnegative().optional(),
    endLine: z.number().int().nonnegative().optional(),
  }),
]);

export const NoteCommandConditionSchema = z.enum(["any", "success", "failure"]);

// What a waiting-on note waits for. The host that owns the note watches it.
export const NoteWaitSchema = z.discriminatedUnion("type", [
  // The agent finishes its turn, errors, or asks for permission/input.
  z.object({
    type: z.literal("agent"),
    agentId: z.string(),
    agentTitle: z.string().optional(),
  }),
  // The next command to finish in this terminal (the running one, or the next one started).
  z.object({
    type: z.literal("terminal-command"),
    terminalId: z.string(),
    condition: NoteCommandConditionSchema,
    command: z.string().optional(),
  }),
  z.object({
    type: z.literal("time"),
    at: z.string(),
  }),
]);

export const NoteWaitResultSchema = z.object({
  at: z.string(),
  // False when the event happened but did not meet the condition (a command succeeded while the
  // note asked for failures). The note stops waiting either way; only a match notifies.
  matched: z.boolean(),
  detail: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
});

// A phone that scheduled its own local notification for a time note. The host then resolves the
// note at that time without sending a push, so the owner gets one alert.
export const NoteLocalReminderSchema = z.object({
  deviceId: z.string(),
  at: z.string(),
});

export const NoteSchema = z.object({
  id: z.string(),
  text: z.string(),
  quote: z.string(),
  anchor: NoteAnchorSchema,
  wait: NoteWaitSchema.nullable().optional(),
  waitResult: NoteWaitResultSchema.nullable().optional(),
  localReminder: NoteLocalReminderSchema.nullable().optional(),
  resolvedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const NotesListRequestSchema = z.object({
  type: z.literal("notes.list.request"),
  requestId: z.string(),
  subscribe: z.object({ subscriptionId: z.string().optional() }).optional(),
});

export const NotesCreateRequestSchema = z.object({
  type: z.literal("notes.create.request"),
  requestId: z.string(),
  text: z.string(),
  quote: z.string(),
  anchor: NoteAnchorSchema,
  wait: NoteWaitSchema.nullable().optional(),
  localReminder: NoteLocalReminderSchema.nullable().optional(),
});

// Omitted fields stay as they are. `resolved: false` reopens a note.
export const NotesEditRequestSchema = z.object({
  type: z.literal("notes.edit.request"),
  requestId: z.string(),
  noteId: z.string(),
  text: z.string().optional(),
  wait: NoteWaitSchema.nullable().optional(),
  localReminder: NoteLocalReminderSchema.nullable().optional(),
  resolved: z.boolean().optional(),
});

export const NotesDeleteRequestSchema = z.object({
  type: z.literal("notes.delete.request"),
  requestId: z.string(),
  noteId: z.string(),
});

export const NotesListResponseSchema = z.object({
  type: z.literal("notes.list.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().optional(),
    notes: z.array(NoteSchema),
    error: z.string().nullable(),
  }),
});

// Live changes for a `notes.list.request` subscription.
export const NotesChangedMessageSchema = z.object({
  type: z.literal("notes.changed"),
  payload: z.discriminatedUnion("kind", [
    z.object({
      subscriptionId: z.string().optional(),
      kind: z.literal("upsert"),
      note: NoteSchema,
    }),
    z.object({
      subscriptionId: z.string().optional(),
      kind: z.literal("remove"),
      noteId: z.string(),
    }),
  ]),
});

// A waiting-on note's event happened. Sent to sources subscribed to the `notes.fired` event;
// `shouldNotify` marks the one client that should show an OS notification.
export const NotesFiredMessageSchema = z.object({
  type: z.literal("notes.fired"),
  payload: z.object({
    serverId: z.string(),
    note: NoteSchema,
    title: z.string(),
    body: z.string(),
    shouldNotify: z.boolean(),
  }),
});

const NoteMutationPayloadSchema = z.object({
  requestId: z.string(),
  note: NoteSchema.nullable(),
  error: z.string().nullable(),
});

export const NotesCreateResponseSchema = z.object({
  type: z.literal("notes.create.response"),
  payload: NoteMutationPayloadSchema,
});

export const NotesEditResponseSchema = z.object({
  type: z.literal("notes.edit.response"),
  payload: NoteMutationPayloadSchema,
});

export const NotesDeleteResponseSchema = z.object({
  type: z.literal("notes.delete.response"),
  payload: z.object({
    requestId: z.string(),
    noteId: z.string(),
    error: z.string().nullable(),
  }),
});

export type Note = z.infer<typeof NoteSchema>;
export type NoteAnchor = z.infer<typeof NoteAnchorSchema>;
export type NoteWait = z.infer<typeof NoteWaitSchema>;
export type NoteWaitResult = z.infer<typeof NoteWaitResultSchema>;
export type NoteCommandCondition = z.infer<typeof NoteCommandConditionSchema>;
export type NoteLocalReminder = z.infer<typeof NoteLocalReminderSchema>;
