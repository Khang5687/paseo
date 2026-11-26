export function sanitizeDownloadFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "download";
  }
  return trimmed.replace(/[\\/:*?"<>|]+/g, "_");
}

export function splitFileName(fileName: string): { base: string; ext: string } {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) {
    return { base: fileName, ext: "" };
  }
  return {
    base: fileName.slice(0, lastDot),
    ext: fileName.slice(lastDot),
  };
}

/** `report.pdf`, then `report (1).pdf`, `report (2).pdf` while `exists` says the name is taken. */
export function uniqueFileName(fileName: string, exists: (name: string) => boolean): string {
  const safeName = sanitizeDownloadFileName(fileName);
  if (!exists(safeName)) {
    return safeName;
  }
  const { base, ext } = splitFileName(safeName);
  let suffix = 1;
  while (exists(`${base} (${suffix})${ext}`)) {
    suffix += 1;
  }
  return `${base} (${suffix})${ext}`;
}
