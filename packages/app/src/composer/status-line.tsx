import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface ComposerStatusLineValue {
  /** The track bar reports how wide its pills are, so an empty line takes no room. */
  reportStatusWidth: (width: number) => void;
}

const ComposerStatusLineContext = createContext<ComposerStatusLineValue | null>(null);

/**
 * Whether this pill or track bar draws inside the phone's status line. Pills there drop their
 * border and fill and shrink to the line's height; the track bar stops floating over the
 * transcript.
 */
export function useComposerStatusLine(): ComposerStatusLineValue | null {
  return useContext(ComposerStatusLineContext);
}

/**
 * The phone's one thin line on the composer's top edge: the pane's tracks on the left ("Your
 * turn · 2 working", tasks, changes), the draft history on the right.
 *
 * On a wide layout the tracks float over the transcript and the draft history sits above the
 * composer as its own pill. On a phone with the keyboard up those two rows, plus the transcript
 * clearance the floating row needs, left about two lines of chat. Here they share one row that is
 * part of the composer's layout, so the transcript ends above it and nothing covers a message.
 *
 * The line takes no room when it has nothing to show. Pills come and go on their own (a plugin
 * pill, the changes pill), so the track bar measures its content and reports it; while hidden
 * the line is still laid out, out of the flow, so the report keeps arriving.
 */
export function ComposerStatusLine({
  children,
  trailing,
}: {
  /** The pane's tracks. */
  children: ReactNode;
  trailing: ReactNode;
}): ReactElement {
  const [statusWidth, setStatusWidth] = useState(0);
  const value = useMemo<ComposerStatusLineValue>(() => ({ reportStatusWidth: setStatusWidth }), []);
  const visible = statusWidth > 0 || trailing != null;
  return (
    <ComposerStatusLineContext.Provider value={value}>
      <View
        style={visible ? styles.line : [styles.line, styles.hidden]}
        pointerEvents={visible ? "box-none" : "none"}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
        testID="composer-status-line"
      >
        <View style={styles.status}>{children}</View>
        {trailing != null ? <View style={styles.trailing}>{trailing}</View> : null}
      </View>
    </ComposerStatusLineContext.Provider>
  );
}

/** Height of the line and of every pill drawn in it. */
export const COMPOSER_STATUS_LINE_HEIGHT = 28;

const styles = StyleSheet.create((theme) => ({
  // The composer's slots sit `spacing[3]` apart; the line pulls the composer up to it, so it reads
  // as the composer's top edge rather than a row of its own.
  line: {
    flexDirection: "row",
    alignItems: "center",
    height: COMPOSER_STATUS_LINE_HEIGHT,
    marginBottom: -theme.spacing[2],
    gap: theme.spacing[2],
  },
  // Out of the flow, so the composer's gap does not count it, but still laid out for the report.
  hidden: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    opacity: 0,
  },
  status: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
  },
  trailing: {
    flexShrink: 0,
  },
}));
