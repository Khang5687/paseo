/** Hands a Blob to the browser's download manager through a temporary link. */
export function saveBrowserFile(file: Blob, fileName: string) {
  if (typeof document === "undefined") {
    return;
  }

  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The browser may still be reading the blob while its save prompt is open.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
