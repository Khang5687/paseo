import { create } from "zustand";

export interface SendToRequest {
  serverId: string;
  path: string;
}

export interface SentFileNotice extends SendToRequest {
  title: string;
}

interface SendToState {
  /** The file whose device picker is open. */
  request: SendToRequest | null;
  open: (request: SendToRequest) => void;
  close: () => void;
  /** A tap on "<file> is ready" waiting for the host: keep the file in Saved, then open it. */
  tapped: SendToRequest | null;
  tap: (request: SendToRequest) => void;
  clearTap: () => void;
  /** "<file> is ready" for the app in the foreground, where a push shows no banner. */
  notice: SentFileNotice | null;
  announce: (notice: SentFileNotice) => void;
  clearNotice: () => void;
}

export const useSendToStore = create<SendToState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
  tapped: null,
  tap: (tapped) => set({ tapped }),
  clearTap: () => set({ tapped: null }),
  notice: null,
  announce: (notice) => set({ notice }),
  clearNotice: () => set({ notice: null }),
}));
