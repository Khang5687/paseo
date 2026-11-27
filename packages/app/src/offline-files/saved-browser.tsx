import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View, type GestureResponderEvent } from "react-native";
import { router } from "expo-router";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  Pin,
  PinOff,
  Share2,
  Trash2,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SearchField } from "@/components/ui/search-field";
import { useToast } from "@/contexts/toast-context";
import { shareFileBytes } from "@/stores/download-store";
import type { Theme } from "@/styles/theme";
import { formatFileSize } from "@/utils/format-file-size";
import { buildSavedFileRoute } from "@/utils/host-routes";
import { SavedFileRow } from "./saved-file-row";
import {
  arrangeSavedFiles,
  filterSavedFiles,
  type SavedFileItem,
  type SavedGrouping,
  type SavedKindFilter,
  type SavedSection,
  type SavedSort,
} from "./saved-list";
import { deleteSavedFilesWithUndo } from "./delete-undo";
import { readOfflineFileBytes, setOfflineFilesPinned, type OfflineFile } from "./store";
import { useSavedFileItems } from "./use-saved-file-items";

const KINDS: readonly SavedKindFilter[] = ["all", "sent", "apps", "docs", "images", "code"];
const SORTS: readonly SavedSort[] = ["newest", "biggest", "name"];
const GROUPINGS: readonly SavedGrouping[] = ["day", "project"];

const ICON_SIZE = 14;

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedSortIcon = withUnistyles(ArrowDownUp);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type Selection = ReadonlySet<string>;
const NO_SELECTION: Selection = new Set();

/** Cmd-click on a Mac, Ctrl-click elsewhere: the desktop way into select mode. */
function isMultiSelectClick(event: GestureResponderEvent): boolean {
  const native = event.nativeEvent as { metaKey?: boolean; ctrlKey?: boolean };
  return native.metaKey === true || native.ctrlKey === true;
}

/**
 * The Saved screen's list: search, a chip row (type, Project, Device) with a sort menu at its
 * end, sections by day or by project, and select mode with a bar to share, pin and delete many
 * files at once.
 */
export function SavedFilesBrowser({ files }: { files: readonly OfflineFile[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const items = useSavedFileItems(files);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SavedKindFilter>("all");
  const [project, setProject] = useState<string | null>(null);
  const [serverId, setServerId] = useState<string | null>(null);
  const [sort, setSort] = useState<SavedSort>("newest");
  const [grouping, setGrouping] = useState<SavedGrouping>("day");
  const [folded, setFolded] = useState<ReadonlySet<string>>(NO_SELECTION);
  const [selected, setSelected] = useState<Selection>(NO_SELECTION);
  // Deleted rows hide at once and go for good when the Undo toast leaves.
  const [hidden, setHidden] = useState<Selection>(NO_SELECTION);

  const live = useMemo(() => items.filter((item) => !hidden.has(item.key)), [items, hidden]);
  const projects = useMemo(
    () =>
      [...new Set(live.map((item) => item.project))].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      ),
    [live],
  );
  const devices = useMemo(() => {
    const byServer = new Map<string, string>();
    for (const item of live) byServer.set(item.file.serverId, item.device);
    return [...byServer.entries()].sort(([, a], [, b]) => a.localeCompare(b));
  }, [live]);
  const shown = useMemo(
    () => filterSavedFiles(live, { query, kind, project, serverId }),
    [live, query, kind, project, serverId],
  );
  const sections = useMemo(
    () => arrangeSavedFiles(shown, { sort, grouping, now: Date.now() }),
    [shown, sort, grouping],
  );
  // A row the filters hide drops out of the selection, so the bar never acts on unseen files.
  const selectedItems = useMemo(
    () => shown.filter((item) => selected.has(item.key)),
    [shown, selected],
  );
  const selecting = selectedItems.length > 0;

  const toggle = useCallback((key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const pressRow = useCallback(
    (item: SavedFileItem, event: GestureResponderEvent) => {
      if (selecting || isMultiSelectClick(event)) {
        toggle(item.key);
        return;
      }
      router.push(buildSavedFileRoute({ serverId: item.file.serverId, path: item.file.path }));
    },
    [selecting, toggle],
  );
  const toggleFold = useCallback((key: string) => {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(NO_SELECTION), []);

  const shareSelected = useCallback(async () => {
    const picked = selectedItems;
    setSelected(NO_SELECTION);
    // The share sheet takes one file; each opens once the one before it closes.
    for (const item of picked) {
      await shareFileBytes({
        bytes: await readOfflineFileBytes(item.file),
        fileName: item.name,
        mimeType: item.file.mimeType,
      });
    }
  }, [selectedItems]);
  const allPinned = selectedItems.every((item) => item.file.pinned === true);
  const pinSelected = useCallback(() => {
    void setOfflineFilesPinned(
      selectedItems.map((item) => item.file),
      !allPinned,
    );
    setSelected(NO_SELECTION);
  }, [allPinned, selectedItems]);
  const deleteSelected = useCallback(() => {
    const keys = new Set(selectedItems.map((item) => item.key));
    setSelected(NO_SELECTION);
    setHidden((current) => new Set([...current, ...keys]));
    deleteSavedFilesWithUndo({
      toast,
      files: selectedItems.map((item) => item.file),
      release: () => setHidden((current) => new Set([...current].filter((key) => !keys.has(key)))),
    });
  }, [selectedItems, toast]);

  const kindLabels: Record<SavedKindFilter, string> = {
    all: t("offlineFiles.library.filters.all"),
    sent: t("offlineFiles.library.filters.sent"),
    apps: t("offlineFiles.library.filters.apps"),
    docs: t("offlineFiles.library.filters.docs"),
    images: t("offlineFiles.library.filters.images"),
    code: t("offlineFiles.library.filters.code"),
  };
  const sortLabels: Record<SavedSort, string> = {
    newest: t("offlineFiles.library.sort.newest"),
    biggest: t("offlineFiles.library.sort.biggest"),
    name: t("offlineFiles.library.sort.name"),
  };
  const groupingLabels: Record<SavedGrouping, string> = {
    day: t("offlineFiles.library.groupBy.day"),
    project: t("offlineFiles.library.groupBy.project"),
  };
  const deviceLabel = devices.find(([id]) => id === serverId)?.[1] ?? null;

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.searchRow}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("offlineFiles.search")}
            clearAccessibilityLabel={t("offlineFiles.library.clearSearch")}
            fullWidth
            testID="offline-files-search"
          />
        </View>
        <View style={styles.chipBar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipScroll}
            contentContainerStyle={styles.chips}
            testID="saved-chips"
          >
            {KINDS.map((value) => (
              <Chip
                key={value}
                value={value}
                label={kindLabels[value]}
                selected={kind === value}
                onChoose={setKind}
              />
            ))}
            <ChipMenu
              label={project ?? t("offlineFiles.library.filters.project")}
              active={project !== null}
              title={t("offlineFiles.library.filters.project")}
              allLabel={t("offlineFiles.library.filters.allProjects")}
              options={projects.map((name) => ({ value: name, label: name }))}
              value={project}
              onChange={setProject}
              testID="saved-chip-project"
            />
            <ChipMenu
              label={deviceLabel ?? t("offlineFiles.library.filters.device")}
              active={serverId !== null}
              title={t("offlineFiles.library.filters.device")}
              allLabel={t("offlineFiles.library.filters.allDevices")}
              options={devices.map(([id, label]) => ({ value: id, label }))}
              value={serverId}
              onChange={setServerId}
              testID="saved-chip-device"
            />
          </ScrollView>
          <DropdownMenu compactMode="sheet">
            <DropdownMenuTrigger
              style={styles.sortButton}
              accessibilityLabel={t("offlineFiles.library.sort.label")}
              testID="saved-sort"
            >
              <ThemedSortIcon size={ICON_SIZE} uniProps={mutedColor} />
              <Text style={styles.chipText}>{sortLabels[sort]}</Text>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              width={200}
              sheetTitle={t("offlineFiles.library.sort.label")}
              testID="saved-sort-menu"
            >
              {SORTS.map((value) => (
                <ChoiceItem
                  key={value}
                  value={value}
                  label={sortLabels[value]}
                  selected={sort === value}
                  onChoose={setSort}
                  testID={`saved-sort-${value}`}
                />
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("offlineFiles.library.groupBy.label")}</DropdownMenuLabel>
              {GROUPINGS.map((value) => (
                <ChoiceItem
                  key={value}
                  value={value}
                  label={groupingLabels[value]}
                  selected={grouping === value}
                  onChoose={setGrouping}
                  testID={`saved-group-${value}`}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
        <View style={styles.list}>
          {sections.map((section) => (
            <View key={section.key} testID={`saved-section-${section.key}`}>
              <SectionHeader
                section={section}
                folded={folded.has(section.key)}
                onToggle={toggleFold}
              />
              {folded.has(section.key)
                ? null
                : section.items.map((item) => (
                    <BrowserRow
                      key={item.key}
                      item={item}
                      selected={selecting ? selected.has(item.key) : undefined}
                      onPress={pressRow}
                      onToggle={toggle}
                    />
                  ))}
            </View>
          ))}
          {sections.length === 0 ? (
            <Text style={styles.noMatches}>{t("offlineFiles.noMatches")}</Text>
          ) : null}
        </View>
      </ScrollView>
      {selecting ? (
        <View
          style={[styles.selectionBar, { paddingBottom: insets.bottom }]}
          testID="saved-selection-bar"
        >
          <Button
            variant="ghost"
            size="sm"
            leftIcon={X}
            onPress={clearSelection}
            accessibilityLabel={t("offlineFiles.library.select.done")}
            testID="saved-selection-close"
          />
          <Text style={styles.selectionCount} numberOfLines={1}>
            {t("offlineFiles.library.select.count", { count: selectedItems.length })}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Share2}
            onPress={shareSelected}
            testID="saved-selection-share"
          >
            {t("offlineFiles.share")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={allPinned ? PinOff : Pin}
            onPress={pinSelected}
            testID="saved-selection-pin"
          >
            {allPinned
              ? t("offlineFiles.library.select.unpin")
              : t("offlineFiles.library.select.pin")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Trash2}
            onPress={deleteSelected}
            testID="saved-selection-delete"
          >
            {t("offlineFiles.library.select.delete")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

/** A row in the browser. A tap opens the file, or picks it in select mode; a long-press picks it. */
function BrowserRow({
  item,
  selected,
  onPress,
  onToggle,
}: {
  item: SavedFileItem;
  selected: boolean | undefined;
  onPress: (item: SavedFileItem, event: GestureResponderEvent) => void;
  onToggle: (key: string) => void;
}): ReactElement {
  const press = useCallback(
    (event: GestureResponderEvent) => onPress(item, event),
    [item, onPress],
  );
  const longPress = useCallback(() => onToggle(item.key), [item.key, onToggle]);
  return <SavedFileRow item={item} onPress={press} onLongPress={longPress} selected={selected} />;
}

function Chip<T extends string>({
  value,
  label,
  selected,
  onChoose,
}: {
  value: T;
  label: string;
  selected: boolean;
  onChoose: (value: T) => void;
}): ReactElement {
  const press = useCallback(() => onChoose(value), [onChoose, value]);
  const state = useMemo(() => ({ checked: selected }), [selected]);
  return (
    <PressHighlight
      accessibilityRole="radio"
      accessibilityState={state}
      highlightStyle={styles.chipPressed}
      onPress={press}
      style={[styles.chip, selected ? styles.chipSelected : null]}
      testID={`saved-chip-${value}`}
    >
      <Text style={styles.chipText}>{label}</Text>
    </PressHighlight>
  );
}

/** One choice in a menu: a ticked row that hands its value back. */
function ChoiceItem<T extends string | null>({
  value,
  label,
  selected,
  onChoose,
  testID,
}: {
  value: T;
  label: string;
  selected: boolean;
  onChoose: (value: T) => void;
  testID: string;
}): ReactElement {
  const choose = useCallback(() => onChoose(value), [onChoose, value]);
  return (
    <DropdownMenuItem selected={selected} showSelectedCheck onSelect={choose} testID={testID}>
      {label}
    </DropdownMenuItem>
  );
}

/** A drop-down chip: All, then one row per value. Shows the picked value while one is set. */
function ChipMenu({
  label,
  active,
  title,
  allLabel,
  options,
  value,
  onChange,
  testID,
}: {
  label: string;
  active: boolean;
  title: string;
  allLabel: string;
  options: readonly { value: string; label: string }[];
  value: string | null;
  onChange: (value: string | null) => void;
  testID: string;
}): ReactElement {
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        style={[styles.chip, active ? styles.chipSelected : null]}
        accessibilityLabel={title}
        testID={testID}
      >
        <Text style={styles.chipText} numberOfLines={1}>
          {label}
        </Text>
        <ThemedChevronDown size={ICON_SIZE} uniProps={mutedColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        width={240}
        maxHeight={360}
        scrollable
        sheetTitle={title}
        testID={`${testID}-menu`}
      >
        <ChoiceItem
          value={null}
          label={allLabel}
          selected={value === null}
          onChoose={onChange}
          testID={`${testID}-all`}
        />
        {options.map((option) => (
          <ChoiceItem
            key={option.value}
            value={option.value}
            label={option.label}
            selected={value === option.value}
            onChoose={onChange}
            testID={`${testID}-option`}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SectionHeader({
  section,
  folded,
  onToggle,
}: {
  section: SavedSection;
  folded: boolean;
  /** Project sections fold; day sections do not. */
  onToggle: (key: string) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const toggle = useCallback(() => onToggle(section.key), [onToggle, section.key]);
  const state = useMemo(() => ({ expanded: !folded }), [folded]);
  if (section.key === "all") return null;
  const count = t("offlineFiles.library.sectionCount", {
    count: section.items.length,
    size: formatFileSize(section.totalBytes),
  });
  if (section.day) {
    return (
      <View style={styles.dayHeader}>
        <Text style={styles.dayTitle}>{t(`offlineFiles.library.day.${section.day}`)}</Text>
        <Text style={styles.headerMeta}>{count}</Text>
      </View>
    );
  }
  const Chevron = folded ? ThemedChevronRight : ThemedChevronDown;
  return (
    <PressHighlight
      onPress={toggle}
      accessibilityRole="button"
      accessibilityState={state}
      style={styles.projectHeader}
      testID="saved-project-header"
    >
      <Chevron size={ICON_SIZE} uniProps={mutedColor} />
      <Text style={styles.projectTitle} numberOfLines={1}>
        {section.project}
      </Text>
      <Text style={styles.headerMeta}>{count}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[6],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    gap: theme.spacing[2],
  },
  searchRow: {
    flexDirection: "row",
  },
  chipBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  chipScroll: {
    flex: 1,
    minWidth: 0,
  },
  chips: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  chip: {
    height: 32,
    maxWidth: 200,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipSelected: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.accent,
  },
  chipPressed: {
    backgroundColor: theme.colors.surface2,
  },
  chipText: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  sortButton: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  list: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  dayHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1.5],
  },
  dayTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  projectHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  projectTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  headerMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  noMatches: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  selectionBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1.5],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  selectionCount: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
