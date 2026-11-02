import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const CODE_RUN_STORAGE_KEY = "code-runs";
const CODE_RUN_STORE_VERSION = 1;
/** Runs remembered for reattaching. Older runs lose their card, not their terminal. */
const MAX_REMEMBERED_RUNS = 100;

const CodeRunRecordSchema = z.object({
  terminalId: z.string(),
  workspaceId: z.string(),
  command: z.string(),
  nonce: z.string(),
  startedAt: z.number(),
  exitCode: z.number().nullable(),
  /** Measured on the host's clock, so phone/host clock skew cannot distort it. */
  durationSeconds: z.number().nullable(),
  stopped: z.boolean(),
});

/** What survives an app restart: which terminal a fence's run lives in and how it ended. */
export type CodeRunRecord = z.infer<typeof CodeRunRecordSchema>;

const CodeRunPersistedStateSchema = z.object({
  records: z.record(z.string(), CodeRunRecordSchema),
});

type CodeRunPersistedState = z.infer<typeof CodeRunPersistedStateSchema>;

/** What the card knows only while it is on screen. Output is never written to storage. */
export type CodeRunLive =
  | { kind: "starting" }
  | { kind: "startFailed" }
  | { kind: "output"; lines: string[] }
  | { kind: "terminalClosed"; lines: string[] };

interface CodeRunState extends CodeRunPersistedState {
  live: Record<string, CodeRunLive>;
}

export const useCodeRunStore = create<CodeRunState>()(
  persist(() => ({ records: {}, live: {} }), {
    name: CODE_RUN_STORAGE_KEY,
    version: CODE_RUN_STORE_VERSION,
    storage: createValidatedPersistStorage(AsyncStorage, CodeRunPersistedStateSchema),
    partialize: (state): CodeRunPersistedState => ({ records: state.records }),
  }),
);

export function setCodeRunLive(key: string, live: CodeRunLive): void {
  useCodeRunStore.setState((state) => ({ live: { ...state.live, [key]: live } }));
}

export function rememberCodeRun(key: string, record: CodeRunRecord): void {
  useCodeRunStore.setState((state) => {
    const entries = Object.entries({ ...state.records, [key]: record });
    entries.sort(([, left], [, right]) => right.startedAt - left.startedAt);
    return { records: Object.fromEntries(entries.slice(0, MAX_REMEMBERED_RUNS)) };
  });
}

export function updateCodeRun(
  key: string,
  patch: Pick<Partial<CodeRunRecord>, "exitCode" | "durationSeconds" | "stopped">,
): void {
  useCodeRunStore.setState((state) => {
    const record = state.records[key];
    if (!record) return state;
    return { records: { ...state.records, [key]: { ...record, ...patch } } };
  });
}

export function forgetCodeRun(key: string): void {
  useCodeRunStore.setState((state) => {
    const { [key]: _record, ...records } = state.records;
    const { [key]: _live, ...live } = state.live;
    return { records, live };
  });
}
