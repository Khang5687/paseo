import { describe, expect, it } from "vitest";
import { sanitizeDownloadFileName, uniqueFileName } from "./file-names";

describe("uniqueFileName", () => {
  it("keeps a free name", () => {
    expect(uniqueFileName("report.pdf", () => false)).toBe("report.pdf");
  });

  it("adds the first free number before the extension", () => {
    const taken = new Set(["report.pdf", "report (1).pdf"]);
    expect(uniqueFileName("report.pdf", (name) => taken.has(name))).toBe("report (2).pdf");
  });

  it("numbers a name without an extension and a dotfile at the end", () => {
    expect(uniqueFileName("Makefile", (name) => name === "Makefile")).toBe("Makefile (1)");
    expect(uniqueFileName(".env", (name) => name === ".env")).toBe(".env (1)");
  });

  it("checks the sanitized name, not the raw one", () => {
    expect(uniqueFileName("a/b.txt", (name) => name === "a_b.txt")).toBe("a_b (1).txt");
  });
});

describe("sanitizeDownloadFileName", () => {
  it("replaces path separators and falls back for an empty name", () => {
    expect(sanitizeDownloadFileName("../x\\y.txt")).toBe(".._x_y.txt");
    expect(sanitizeDownloadFileName("  ")).toBe("download");
  });
});
