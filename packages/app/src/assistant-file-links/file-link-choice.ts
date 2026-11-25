import { create } from "zustand";

export interface FileChoiceRequest {
  /** Absolute paths of the files the link may mean. */
  paths: readonly string[];
  /** Paths under this folder show relative to it. */
  workspaceRoot: string;
  onChoose: (path: string | null) => void;
}

interface FileChoiceState {
  request: FileChoiceRequest | null;
  open: (request: FileChoiceRequest) => void;
  /** Closes the question and reports the choice, or null for none. */
  settle: (path: string | null) => void;
}

/** Holds the open "which file?" question. `FileLinkChooserSheet` renders it. */
export const useFileChoiceStore = create<FileChoiceState>((set, get) => ({
  request: null,
  open: (request) => {
    get().request?.onChoose(null);
    set({ request });
  },
  settle: (path) => {
    const request = get().request;
    set({ request: null });
    request?.onChoose(path);
  },
}));

/**
 * Asks which of several files a chat link means, outside React. Resolves null when the question
 * closes without a choice. Needs `FileLinkChooserSheet` mounted, as the app root does.
 */
export function chooseFileFrom(input: {
  paths: readonly string[];
  workspaceRoot: string;
}): Promise<string | null> {
  // Executor form: no shipped app code relies on Promise.withResolvers under Hermes.
  let resolve!: (path: string | null) => void;
  const promise = new Promise<string | null>((settle) => {
    resolve = settle;
  });
  useFileChoiceStore.getState().open({ ...input, onChoose: resolve });
  return promise;
}

/** The path a row shows: relative to the workspace root when it lies inside, else as given. */
export function formatChoicePath(path: string, workspaceRoot: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = path.replace(/\\/g, "/");
  return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}
