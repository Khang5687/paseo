import { useCallback, useEffect, useRef } from "react";
import type { AgentPermissionDraft } from "@getpaseo/protocol/agent-types";
import {
  draftFromQuestionForm,
  questionFormFromDraft,
  type QuestionFiles,
  type QuestionFormDraftState,
  type QuestionOtherTexts,
} from "./question-form-card-core";

const DRAFT_PUBLISH_DELAY_MS = 400;

/**
 * Keeps a question box's picks the same on every device (owner decision Q105). Local edits go to
 * the host once typing pauses; a newer draft from another device replaces the box's state. Only
 * edits marked with the returned callback are published, so a draft received from the host is
 * never sent back.
 */
export function useQuestionFormDraftSync(input: {
  selections: Record<number, ReadonlySet<number>>;
  otherTexts: QuestionOtherTexts;
  files: QuestionFiles;
  remoteDraft: AgentPermissionDraft | undefined;
  onDraftChange: ((draft: AgentPermissionDraft) => void) | undefined;
  applyRemote: (state: QuestionFormDraftState) => void;
}): () => void {
  const { selections, otherTexts, files, remoteDraft, onDraftChange, applyRemote } = input;
  const editedRef = useRef(false);
  const seenRef = useRef(remoteDraft?.updatedAt ?? 0);

  useEffect(() => {
    if (!editedRef.current || !onDraftChange) return undefined;
    const timer = setTimeout(() => {
      editedRef.current = false;
      const updatedAt = Math.max(Date.now(), seenRef.current + 1);
      seenRef.current = updatedAt;
      onDraftChange(draftFromQuestionForm({ selections, otherTexts, files, updatedAt }));
    }, DRAFT_PUBLISH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [files, onDraftChange, otherTexts, selections]);

  useEffect(() => {
    if (!remoteDraft || remoteDraft.updatedAt <= seenRef.current) return;
    seenRef.current = remoteDraft.updatedAt;
    editedRef.current = false;
    applyRemote(questionFormFromDraft(remoteDraft));
  }, [applyRemote, remoteDraft]);

  return useCallback(() => {
    editedRef.current = true;
  }, []);
}
