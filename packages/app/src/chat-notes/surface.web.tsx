import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { StickyNotePlus } from "lucide-react-native";
import { useChatFindSearch } from "@/agent-stream/chat-find";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getOverlayRoot, useOverlayLayer } from "@/lib/overlay-root";
import { useNoteFocusStore } from "@/notes/focus-store";
import type { Note } from "@/notes/model";
import { chatNoteHighlightKind, noteFindQuery, type ChatNoteHighlightKind } from "./anchor";
import {
  openChatNoteComposer,
  useChatNoteFocusTarget,
  useChatNotes,
  useChatNotesTarget,
  type ChatNoteSelection,
  type ChatNotesTarget,
} from "./context";
import { ChatRowIndex, findNoteRange, noteRangeRow, readChatSelection } from "./dom.web";
import type { ChatNotesSurfaceProps } from "./types";

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };
const HIGHLIGHT_KINDS: readonly ChatNoteHighlightKind[] = ["open", "fired", "resolved"];
/** How long a jump may wait for its message to mount and render before giving up on it. */
const JUMP_TIMEOUT_MS = 5000;
const FLASH_MS = 1600;
/** Room left above a jumped-to passage so the text leading into it stays readable. */
const JUMP_TOP_CLEARANCE_PX = 72;
const PILL_GAP_PX = 8;
/** Half the pill's width, so a pill near a viewport edge stays fully on screen. */
const PILL_EDGE_PX = 64;
/** The pill's height, for flipping it below a selection that hugs the top of the chat. */
const PILL_HEIGHT_PX = 36;
const CHAT_SCROLL_SELECTOR = '[data-testid="agent-chat-scroll"]';

let nextSurfaceId = 0;

interface HighlightNames {
  open: string;
  fired: string;
  resolved: string;
  flash: string;
}

function supportsHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

function preventSelectionLoss(event: MouseEvent) {
  event.preventDefault();
}

/**
 * Web chat notes over the stream: "Add note" on a text selection, highlights on noted passages,
 * and the jump to a note opened from elsewhere.
 */
export function ChatNotesSurface({
  viewportRef,
  revealLoadedMessage,
  visibleMessageIds,
  children,
}: ChatNotesSurfaceProps) {
  const target = useChatNotesTarget();
  const rootRef = useRef<HTMLDivElement>(null);
  const [names] = useState<HighlightNames>(() => {
    const id = ++nextSurfaceId;
    return {
      open: `paseo-chat-note-open-${id}`,
      fired: `paseo-chat-note-fired-${id}`,
      resolved: `paseo-chat-note-resolved-${id}`,
      flash: `paseo-chat-note-flash-${id}`,
    };
  });
  const bindings = useRef({ viewportRef, revealLoadedMessage, visibleMessageIds });
  bindings.current = { viewportRef, revealLoadedMessage, visibleMessageIds };
  const notes = useChatNotes();
  useNoteHighlights(rootRef, notes, names);
  useNoteJump(rootRef, bindings, names.flash);
  return (
    <div ref={rootRef} style={DISPLAY_CONTENTS}>
      {target && supportsHighlights() ? <style>{highlightCss(names)}</style> : null}
      {children}
      {target ? <SelectionAddNote target={target} rootRef={rootRef} /> : null}
    </div>
  );
}

function highlightCss(names: HighlightNames): string {
  const { open, fired, resolved, flash } = styles;
  return [
    `::highlight(${names.open}) { background-color: color-mix(in srgb, ${open.color} 28%, transparent); text-decoration: underline ${open.color}; }`,
    `::highlight(${names.fired}) { background-color: color-mix(in srgb, ${fired.color} 28%, transparent); text-decoration: underline ${fired.color}; }`,
    `::highlight(${names.resolved}) { text-decoration: underline dotted ${resolved.color}; }`,
    `::highlight(${names.flash}) { background-color: ${flash.backgroundColor}; color: ${flash.color}; }`,
  ].join("\n");
}

/**
 * Paints every mounted noted passage. Rows mount, stream and virtualize under the highlights,
 * which hold live ranges into text nodes that React may replace, so any DOM change in the chat
 * repaints once on the next frame.
 */
function useNoteHighlights(
  rootRef: RefObject<HTMLDivElement | null>,
  notes: readonly Note[],
  names: HighlightNames,
) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !supportsHighlights()) return;
    const clear = () => {
      for (const kind of HIGHLIGHT_KINDS) CSS.highlights.delete(names[kind]);
    };
    if (notes.length === 0) {
      clear();
      return;
    }
    let frame = 0;
    const paint = () => {
      frame = 0;
      const index = new ChatRowIndex(root);
      const ranges: Record<ChatNoteHighlightKind, Range[]> = { open: [], fired: [], resolved: [] };
      for (const note of notes) {
        const range = findNoteRange(index, note);
        if (range) ranges[chatNoteHighlightKind(note)].push(range);
      }
      for (const kind of HIGHLIGHT_KINDS) {
        if (ranges[kind].length > 0)
          CSS.highlights.set(names[kind], new Highlight(...ranges[kind]));
        else CSS.highlights.delete(names[kind]);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    paint();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      clear();
    };
  }, [rootRef, notes, names]);
}

type SurfaceBindings = RefObject<Omit<ChatNotesSurfaceProps, "children">>;

/**
 * Consumes a jump aimed at this chat: brings the note's message on screen (opening a collapsed
 * turn or earlier loaded history first), scrolls its passage into view and flashes it. A message
 * that is not loaded at all is found through chat find's host search instead.
 */
function useNoteJump(
  rootRef: RefObject<HTMLDivElement | null>,
  bindings: SurfaceBindings,
  flashName: string,
) {
  const focus = useChatNoteFocusTarget();
  const active = useRetainedPanelActive();
  const search = useChatFindSearch();
  const searchRef = useRef(search);
  searchRef.current = search;
  // The settle scroll outlives the jump request, which is cleared as soon as it starts; only a
  // newer jump or unmounting cancels it.
  const scrollRef = useRef<AbortController | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      scrollRef.current?.abort();
      clearTimeout(flashTimer.current);
      if (supportsHighlights()) CSS.highlights.delete(flashName);
    },
    [flashName],
  );

  useEffect(() => {
    if (!focus || !active) return;
    const { note, requestId } = focus;
    const anchor = note.anchor;
    if (anchor.kind !== "agent") return;
    const messageId = anchor.messageId;
    const deadline = performance.now() + JUMP_TIMEOUT_MS;
    let frame = 0;
    let revealed = false;
    let scrolledToMessage = false;
    const done = () => useNoteFocusStore.getState().clear(requestId);
    const searchHistory = () => {
      const query = noteFindQuery(note.quote);
      if (query) searchRef.current?.(query);
      done();
    };
    const land = (root: HTMLElement, range: Range) => {
      const landingMessageId = noteRangeRow(range)?.messageId ?? messageId;
      if (!landingMessageId) return;
      scrollRef.current?.abort();
      const controller = new AbortController();
      scrollRef.current = controller;
      const flashUntil = performance.now() + FLASH_MS;
      const flash = (passage: Range) => {
        if (!supportsHighlights() || performance.now() >= flashUntil) return;
        const highlight = new Highlight(passage);
        highlight.priority = 1;
        CSS.highlights.set(flashName, highlight);
      };
      bindings.current?.viewportRef.current?.scrollToMessage?.(landingMessageId, {
        signal: controller.signal,
        targetTop() {
          const passage = findNoteRange(new ChatRowIndex(root), note);
          if (!passage) return null;
          flash(passage);
          return passage.getBoundingClientRect().top - JUMP_TOP_CLEARANCE_PX;
        },
      });
      flash(range);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => {
        if (supportsHighlights()) CSS.highlights.delete(flashName);
      }, FLASH_MS);
    };
    const poll = () => {
      frame = 0;
      const root = rootRef.current;
      const current = bindings.current;
      if (!root || !current) return;
      if (messageId && !current.visibleMessageIds.has(messageId)) {
        if (!revealed) {
          revealed = true;
          if (!current.revealLoadedMessage(messageId)) {
            searchHistory();
            return;
          }
        }
        if (performance.now() >= deadline) {
          searchHistory();
          return;
        }
        frame = requestAnimationFrame(poll);
        return;
      }
      if (messageId && !scrolledToMessage) {
        // A virtualized message has no rows until the list scrolls to it.
        scrolledToMessage = true;
        current.viewportRef.current?.scrollToMessage?.(messageId);
      }
      const range = findNoteRange(new ChatRowIndex(root), note);
      if (range) {
        land(root, range);
        done();
        return;
      }
      if (performance.now() >= deadline) {
        // The message is on screen but no longer holds the quote; showing it is the best jump.
        if (messageId) done();
        else searchHistory();
        return;
      }
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frame);
  }, [active, bindings, flashName, focus, rootRef]);
}

interface PillState {
  left: number;
  top: number;
  placement: "above" | "below";
  selection: ChatNoteSelection;
}

function selectionEndRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);
  return rects[rects.length - 1] ?? null;
}

/** Where the "Add note" pill belongs for the current selection, or null when it has none. */
function readPill(root: HTMLElement | null): PillState | null {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const chatSelection = readChatSelection(root, range);
  if (!chatSelection) return null;
  const end = selectionEndRect(range);
  if (!end) return null;
  const viewport = root.querySelector(CHAT_SCROLL_SELECTOR)?.getBoundingClientRect();
  if (viewport && (end.bottom < viewport.top || end.top > viewport.bottom)) return null;
  // Touch browsers draw their own selection menu above the selection; stay clear of it.
  const touch = window.matchMedia("(pointer: coarse)").matches;
  const roomAbove = end.top - (viewport?.top ?? 0) >= PILL_HEIGHT_PX + PILL_GAP_PX;
  const placement = touch || !roomAbove ? "below" : "above";
  const { row, quote, span } = chatSelection;
  return {
    left: Math.min(Math.max(end.right, PILL_EDGE_PX), window.innerWidth - PILL_EDGE_PX),
    top: placement === "above" ? end.top - PILL_GAP_PX : end.bottom + PILL_GAP_PX,
    placement,
    selection: {
      quote,
      rowId: row.rowId,
      messageId: row.messageId,
      role: row.role,
      start: span?.start,
      end: span?.end,
    },
  };
}

function SelectionAddNote({
  target,
  rootRef,
}: {
  target: ChatNotesTarget;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const layer = useOverlayLayer("floating");
  const [pill, setPill] = useState<PillState | null>(null);
  // A tap on a touch screen can collapse the selection before the press lands; the pill stays
  // until the press is over.
  const pressing = useRef(false);
  const update = useStableEvent(() => {
    if (!pressing.current) setPill(readPill(rootRef.current));
  });

  useEffect(() => {
    if (!active) {
      setPill(null);
      return;
    }
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [active, update]);

  const handlePressIn = useCallback(() => {
    pressing.current = true;
  }, []);
  const handlePressOut = useCallback(() => {
    pressing.current = false;
    setTimeout(update, 0);
  }, [update]);
  const handlePress = useCallback(() => {
    if (!pill) return;
    openChatNoteComposer(target, pill.selection);
    window.getSelection()?.removeAllRanges();
    setPill(null);
  }, [pill, target]);

  const frameStyle = useMemo<CSSProperties | null>(
    () =>
      pill && {
        position: "absolute",
        left: pill.left,
        top: pill.top,
        transform: pill.placement === "above" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
        zIndex: layer,
        pointerEvents: "auto",
      },
    [layer, pill],
  );

  if (!pill || !frameStyle) return null;
  return createPortal(
    // Pressing must not move focus or collapse the selection the note is made from.
    <div style={frameStyle} onMouseDown={preventSelectionLoss}>
      <Button
        size="sm"
        variant="secondary"
        leftIcon={StickyNotePlus}
        style={styles.pill}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={handlePress}
        testID="chat-add-note"
      >
        {t("notes.addNote")}
      </Button>
    </div>,
    getOverlayRoot(),
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    ...theme.shadow.md,
  },
  open: { color: theme.colors.statusWarning },
  fired: { color: theme.colors.statusSuccess },
  resolved: { color: theme.colors.foregroundMuted },
  flash: { backgroundColor: theme.colors.statusWarning, color: theme.colors.surface0 },
}));
