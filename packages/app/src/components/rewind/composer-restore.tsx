import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import type { ComposerTextSource } from "@/composer/text-source";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

interface RewindComposerRestoreContextValue {
  completeRewind: (text: string, images: readonly AttachmentMetadata[]) => void;
}

interface RewindComposerRestoreProviderProps {
  textSource: ComposerTextSource;
  setText: (text: string) => void;
  setAttachments: (
    updater: (current: UserComposerAttachment[]) => UserComposerAttachment[],
  ) => void;
  onRewindComplete: () => void;
  children: ReactNode;
}

const RewindComposerRestoreContext = createContext<RewindComposerRestoreContextValue | null>(null);

export function restoreComposerTextIfEmpty(input: {
  currentText: string;
  rewoundText: string;
}): string {
  if (input.currentText.length > 0) {
    return input.currentText;
  }
  return input.rewoundText;
}

/**
 * Images are always restored, even when an existing draft keeps its text: the
 * rewound message's sent-message entry is dropped afterwards, so skipping them
 * here would let attachment GC delete the only copy.
 */
export function restoreComposerImages(input: {
  current: UserComposerAttachment[];
  rewoundImages: readonly AttachmentMetadata[];
}): UserComposerAttachment[] {
  const present = new Set<string>();
  for (const attachment of input.current) {
    if (attachment.kind === "image") present.add(attachment.metadata.id);
  }
  const restored = input.rewoundImages
    .filter((metadata) => !present.has(metadata.id))
    .map((metadata): UserComposerAttachment => ({ kind: "image", metadata }));
  return restored.length === 0 ? input.current : [...input.current, ...restored];
}

export function RewindComposerRestoreProvider({
  textSource,
  setText,
  setAttachments,
  onRewindComplete,
  children,
}: RewindComposerRestoreProviderProps) {
  const completeRewind = useCallback(
    (rewoundText: string, rewoundImages: readonly AttachmentMetadata[]) => {
      const currentText = textSource.getSnapshot();
      const nextText = restoreComposerTextIfEmpty({
        currentText: currentText,
        rewoundText,
      });
      if (nextText !== currentText) {
        setText(nextText);
      }
      if (rewoundImages.length > 0) {
        setAttachments((current) => restoreComposerImages({ current, rewoundImages }));
      }
      onRewindComplete();
    },
    [onRewindComplete, setAttachments, setText, textSource],
  );

  const value = useMemo(() => ({ completeRewind }), [completeRewind]);

  return (
    <RewindComposerRestoreContext.Provider value={value}>
      {children}
    </RewindComposerRestoreContext.Provider>
  );
}

export function useRewindComposerRestore(): RewindComposerRestoreContextValue | null {
  return useContext(RewindComposerRestoreContext);
}
