import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

const COPIED_RESET_MS = 1500;

/**
 * The quiet button beside Send (owner decision Q216). It copies the text Send would send and
 * sends nothing, so every question stays open. `getText` builds that text when the button is
 * pressed, from the same builder Send uses; null means nothing is answered.
 */
export function CopyAnswersButton({
  getText,
  disabled,
  testID,
}: {
  getText: () => string | null;
  disabled: boolean;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const handleCopy = useCallback(async () => {
    const text = getText();
    if (!text) return;
    await Clipboard.setStringAsync(text);
    setCopied(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, [getText]);

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      leftIcon={copied ? Check : Copy}
      onPress={handleCopy}
      testID={testID}
    >
      {copied ? t("questions.copiedAnswers") : t("questions.copyAnswers")}
    </Button>
  );
}
