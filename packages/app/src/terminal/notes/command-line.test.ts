import { describe, expect, it } from "vitest";

import { terminalSelectionCommand } from "./command-line";

describe("terminalSelectionCommand", () => {
  it("returns a bare command line", () => {
    expect(terminalSelectionCommand("npm run build")).toBe("npm run build");
    expect(terminalSelectionCommand("  ./scripts/dev.sh --watch  ")).toBe(
      "./scripts/dev.sh --watch",
    );
    expect(terminalSelectionCommand("FOO=1 npm test")).toBe("FOO=1 npm test");
  });

  it("strips a leading prompt", () => {
    expect(terminalSelectionCommand("$ git status")).toBe("git status");
    expect(terminalSelectionCommand("% ls -la")).toBe("ls -la");
    expect(terminalSelectionCommand("❯ cargo test")).toBe("cargo test");
    expect(terminalSelectionCommand("me@box:~/src$ make all")).toBe("make all");
  });

  it("keeps capitalised commands behind a prompt", () => {
    expect(terminalSelectionCommand("$ Rscript run.R")).toBe("Rscript run.R");
  });

  it("rejects multi-line selections", () => {
    expect(terminalSelectionCommand("npm test\nPASS src/a.test.ts")).toBeUndefined();
  });

  it("rejects output that does not look like a command", () => {
    expect(terminalSelectionCommand("Compiling paseo v1.2.0")).toBeUndefined();
    expect(terminalSelectionCommand("error: cannot find module")).toBeUndefined();
    expect(terminalSelectionCommand("12:30:01 ready")).toBeUndefined();
    expect(terminalSelectionCommand("https://example.com/docs")).toBeUndefined();
  });

  it("rejects empty selections and a bare prompt", () => {
    expect(terminalSelectionCommand("")).toBeUndefined();
    expect(terminalSelectionCommand("   ")).toBeUndefined();
    expect(terminalSelectionCommand("$ ")).toBeUndefined();
  });
});
