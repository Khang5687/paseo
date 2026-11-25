export interface MediaPlayerProps {
  /** A URL the device plays from: blob: on web, file:// on native. */
  url: string;
  kind: "video" | "audio";
  testID?: string;
  /** The device cannot play the file at `url`, e.g. an unsupported codec. */
  onError: (url: string) => void;
}
