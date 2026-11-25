import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Copy, ExternalLink } from "lucide-react-native";
import type { OmpAccountRoutingState } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EditingTextInput } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  describeAddAccount,
  type AddAccountFlow,
  type AddAccountResult,
  type AddAccountView,
} from "./add-account-flow";
import type { HostAccountLogin } from "./queries";

const SNAP_POINTS = ["72%", "92%"];
const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface AddAccountSheetProps {
  login: HostAccountLogin;
  flow: AddAccountFlow;
  accounts: OmpAccountRoutingState["accounts"];
  visible: boolean;
  /** Hides the sheet. The login keeps running; the section shows it. */
  onClose: () => void;
}

/**
 * Add a Claude account from the desktop app on the host's computer. Which step shows comes from
 * the host's login; the sheet only holds the paste field. It never opens the link by itself.
 */
export function AddAccountSheet({ login, flow, accounts, visible, onClose }: AddAccountSheetProps) {
  const { t } = useTranslation();
  const local = useSyncExternalStore(flow.subscribe, flow.getState);
  const view = describeAddAccount(login.snapshot, accounts, local);
  const linkStep = view.step === "link" || view.step === "verifying";
  const header = useMemo<SheetHeader>(
    () => ({
      title: linkStep
        ? t("ompAccountRouting.login.link.title")
        : t("ompAccountRouting.login.start"),
    }),
    [linkStep, t],
  );
  const finish = useCallback(() => {
    login.dismiss();
    onClose();
  }, [login, onClose]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      desktopMaxWidth={520}
      testID="omp-add-sheet"
    >
      <View style={styles.body} testID="omp-add-content">
        <StepBody view={view} login={login} flow={flow} onClose={onClose} onFinish={finish} />
      </View>
    </AdaptiveModalSheet>
  );
}

interface StepProps {
  view: AddAccountView;
  login: HostAccountLogin;
  flow: AddAccountFlow;
  onClose: () => void;
  onFinish: () => void;
}

function StepBody(props: StepProps) {
  const { view, login, onFinish } = props;
  const { t } = useTranslation();
  switch (view.step) {
    case "warning":
      return <WarningStep {...props} />;
    case "link":
      return <LinkStep {...props} />;
    case "result":
      return view.result ? (
        <ResultStep result={view.result} login={login} onFinish={onFinish} />
      ) : null;
    default:
      return (
        <>
          <Waiting
            text={
              view.step === "verifying"
                ? t("ompAccountRouting.login.verifying")
                : t("ompAccountRouting.login.preparing")
            }
          />
          <Actions>
            <Button variant="outline" onPress={login.cancel} testID="omp-add-cancel">
              {t("ompAccountRouting.login.cancelSignIn")}
            </Button>
          </Actions>
        </>
      );
  }
}

function Actions({ children }: { children: React.ReactNode }) {
  const compact = useIsCompactFormFactor();
  return <View style={compact ? styles.actionsCompact : styles.actions}>{children}</View>;
}

function Waiting({ text }: { text: string }) {
  return (
    <View style={styles.waiting} testID="omp-add-waiting">
      <ThemedSpinner size="small" uniProps={mutedColor} />
      <Text style={styles.muted}>{text}</Text>
    </View>
  );
}

function WarningStep({ view, login, onClose }: StepProps) {
  const { t } = useTranslation();
  return (
    <>
      <Text style={styles.text}>{t("ompAccountRouting.login.warning.body")}</Text>
      {view.existingLabels.length > 0 ? (
        <Text style={styles.text} testID="omp-add-existing">
          {t("ompAccountRouting.login.warning.existing", {
            accounts: view.existingLabels.join(", "),
          })}
        </Text>
      ) : null}
      <Alert
        variant="warning"
        title={t("ompAccountRouting.login.warning.alertTitle")}
        description={t("ompAccountRouting.login.warning.alertDescription")}
        testID="omp-add-warning"
      />
      <Text style={styles.muted}>{t("ompAccountRouting.login.warning.guard")}</Text>
      <Actions>
        <Button variant="default" onPress={login.start} testID="omp-add-continue">
          {t("ompAccountRouting.login.continue")}
        </Button>
        <Button variant="outline" onPress={onClose} testID="omp-add-dismiss">
          {t("ompAccountRouting.login.cancel")}
        </Button>
      </Actions>
    </>
  );
}

function LinkStep({ view, login, flow }: StepProps) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const [copied, setCopied] = useState(false);
  const url = view.authorizeUrl ?? "";
  // The user opens the link; nothing here ever does it for them.
  const open = useCallback(() => void openExternalUrl(url).catch(() => undefined), [url]);
  const copy = useCallback(async () => {
    await copyToClipboard(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [url]);
  const copyPress = useCallback(() => void copy(), [copy]);
  const openPaste = useCallback(() => flow.openPaste(), [flow]);
  return (
    <>
      <Text style={styles.text}>{t("ompAccountRouting.login.link.step")}</Text>
      <Button variant="default" leftIcon={ExternalLink} onPress={open} testID="omp-add-open">
        {t("ompAccountRouting.login.link.open")}
      </Button>
      <View style={compact ? styles.linkColumn : styles.linkRow}>
        <View style={styles.inputWrapper}>
          <EditingTextInput
            key={url}
            style={styles.linkInput}
            initialValue={url}
            readOnly
            selectTextOnFocus
            accessibilityLabel={t("ompAccountRouting.login.link.label")}
            testID="omp-add-link"
          />
        </View>
        <Button
          variant="outline"
          size={compact ? "md" : "sm"}
          leftIcon={copied ? Check : Copy}
          onPress={copyPress}
          testID="omp-add-copy"
        >
          {copied
            ? t("ompAccountRouting.login.link.copied")
            : t("ompAccountRouting.login.link.copy")}
        </Button>
      </View>
      <Text style={styles.muted}>{t("ompAccountRouting.login.link.hint")}</Text>
      <Waiting text={t("ompAccountRouting.login.link.waiting")} />
      {view.canPaste && !view.pasteOpen ? (
        <Button variant="ghost" onPress={openPaste} testID="omp-add-paste-toggle">
          {t("ompAccountRouting.login.link.pasteInstead")}
        </Button>
      ) : null}
      {view.pasteOpen ? <PasteField view={view} login={login} flow={flow} /> : null}
      <Actions>
        <Button variant="outline" onPress={login.cancel} testID="omp-add-cancel">
          {t("ompAccountRouting.login.cancelSignIn")}
        </Button>
      </Actions>
    </>
  );
}

function PasteField({ view, login, flow }: Pick<StepProps, "view" | "login" | "flow">) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const submit = useCallback(() => {
    if (view.canSubmit) login.submitCode(view.pasteText.trim());
  }, [login, view.canSubmit, view.pasteText]);
  const change = useCallback((text: string) => flow.setPasteText(text), [flow]);
  return (
    <View style={styles.paste} testID="omp-add-paste">
      <Field
        label={t("ompAccountRouting.login.paste.label")}
        hint={t("ompAccountRouting.login.paste.hint")}
      >
        <FormTextInput
          initialValue={view.pasteText}
          onChangeText={change}
          placeholder={t("ompAccountRouting.login.paste.placeholder")}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!view.submitting}
          returnKeyType="send"
          onSubmitEditing={submit}
          size={compact ? "md" : "sm"}
          accessibilityLabel={t("ompAccountRouting.login.paste.label")}
          testID="omp-add-paste-input"
        />
      </Field>
      {view.pasteError ? (
        <Text accessibilityRole="alert" style={styles.error} testID="omp-add-paste-error">
          {t(`ompAccountRouting.login.paste.error.${view.pasteError}`)}
        </Text>
      ) : null}
      <Button
        variant="default"
        size={compact ? "md" : "sm"}
        onPress={submit}
        disabled={!view.canSubmit}
        loading={view.submitting}
        testID="omp-add-paste-submit"
      >
        {view.submitting
          ? t("ompAccountRouting.login.paste.checking")
          : t("ompAccountRouting.login.paste.submit")}
      </Button>
    </View>
  );
}

function resultTexts(result: AddAccountResult, t: TFunction) {
  const account = result.label;
  const base = "ompAccountRouting.login.result";
  switch (result.kind) {
    case "added": {
      const description = result.organization
        ? t(`${base}.added.description`, { organization: result.organization })
        : t(`${base}.added.descriptionUnnamed`);
      return {
        variant: "success" as const,
        title: account ? t(`${base}.added.title`, { account }) : t(`${base}.added.titleUnnamed`),
        description,
        extra:
          result.billing === null
            ? null
            : t(
                result.billing === "enabled"
                  ? `${base}.added.billingEnabled`
                  : `${base}.added.billingUnknown`,
              ),
      };
    }
    case "alreadyListed":
      return {
        variant: "warning" as const,
        title: account
          ? t(`${base}.alreadyListed.title`, { account })
          : t(`${base}.alreadyListed.titleUnnamed`),
        description: t(`${base}.alreadyListed.description`),
        extra: null,
      };
    case "replaced":
      return {
        variant: "warning" as const,
        title: account
          ? t(`${base}.replaced.title`, { account })
          : t(`${base}.replaced.titleUnnamed`),
        description: t(`${base}.replaced.description`),
        extra: null,
      };
    case "cancelled":
      return {
        variant: "default" as const,
        title: t(`${base}.cancelled`),
        description: null,
        extra: null,
      };
    default:
      return {
        variant: "error" as const,
        title: t(`${base}.failed`),
        description: t(`ompAccountRouting.login.failure.${result.failure ?? "omp_failed"}`),
        extra: null,
      };
  }
}

/** What a finished login says, shared by the sheet and the section line. */
export function useResultHeadline(result: AddAccountResult): string {
  const { t } = useTranslation();
  return resultTexts(result, t).title;
}

function ResultStep({
  result,
  login,
  onFinish,
}: {
  result: AddAccountResult;
  login: HostAccountLogin;
  onFinish: () => void;
}) {
  const { t } = useTranslation();
  const text = resultTexts(result, t);
  const retry =
    result.kind === "alreadyListed" || result.kind === "failed" || result.kind === "cancelled";
  return (
    <>
      <Alert
        variant={text.variant}
        title={text.title}
        description={text.description ?? undefined}
        testID="omp-add-result"
      />
      {text.extra ? (
        <Text style={styles.muted} testID="omp-add-billing">
          {text.extra}
        </Text>
      ) : null}
      <Actions>
        {retry ? (
          <>
            <Button variant="default" onPress={login.dismiss} testID="omp-add-try-again">
              {t("ompAccountRouting.login.tryAgain")}
            </Button>
            <Button variant="outline" onPress={onFinish} testID="omp-add-close">
              {t("ompAccountRouting.login.close")}
            </Button>
          </>
        ) : (
          <Button variant="default" onPress={onFinish} testID="omp-add-done">
            {t("ompAccountRouting.login.done")}
          </Button>
        )}
      </Actions>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[6],
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  waiting: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  actions: { flexDirection: "row-reverse", justifyContent: "flex-start", gap: theme.spacing[3] },
  actionsCompact: { flexDirection: "column", gap: theme.spacing[2] },
  linkRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  linkColumn: { flexDirection: "column", gap: theme.spacing[2] },
  inputWrapper: {
    flex: 1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  linkInput: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    outlineStyle: "none",
  } as object,
  paste: { gap: theme.spacing[2] },
}));
