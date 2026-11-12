import { describe, expect, it } from "vitest";
import { resolveFilePathMenuPaths } from "./paths";

describe("resolveFilePathMenuPaths", () => {
  it("expands a home-relative path with the host's home directory", () => {
    expect(
      resolveFilePathMenuPaths({
        path: "~/.config/fcm-key.json",
        workspaceRoot: "/Users/test/project",
        homeDirectory: "/Users/test",
      }),
    ).toEqual({
      absolutePath: "/Users/test/.config/fcm-key.json",
      relativePath: null,
      fileName: "fcm-key.json",
    });
  });

  it("gives a home-relative path inside the workspace its relative form", () => {
    expect(
      resolveFilePathMenuPaths({
        path: "~/project/src/app.ts",
        workspaceRoot: "/Users/test/project",
        homeDirectory: "/Users/test/",
      }),
    ).toEqual({
      absolutePath: "/Users/test/project/src/app.ts",
      relativePath: "src/app.ts",
      fileName: "app.ts",
    });
  });

  it("has no paths for a home-relative path while the home directory is unknown", () => {
    expect(
      resolveFilePathMenuPaths({
        path: "~/notes.md",
        workspaceRoot: "/Users/test/project",
        homeDirectory: null,
      }),
    ).toBeNull();
  });

  it("anchors a relative path to the workspace root", () => {
    expect(
      resolveFilePathMenuPaths({
        path: "src/app.ts",
        workspaceRoot: "/Users/test/project",
        homeDirectory: null,
      }),
    ).toEqual({
      absolutePath: "/Users/test/project/src/app.ts",
      relativePath: "src/app.ts",
      fileName: "app.ts",
    });
  });

  it("has no paths for a relative path without a workspace root", () => {
    expect(
      resolveFilePathMenuPaths({ path: "src/app.ts", workspaceRoot: "", homeDirectory: "/home/u" }),
    ).toBeNull();
  });

  it("keeps an absolute path outside the workspace without a relative form", () => {
    expect(
      resolveFilePathMenuPaths({
        path: "/etc/hosts",
        workspaceRoot: "/Users/test/project",
        homeDirectory: null,
      }),
    ).toEqual({ absolutePath: "/etc/hosts", relativePath: null, fileName: "hosts" });
  });

  it("names the workspace directory itself when the path is the workspace root", () => {
    expect(
      resolveFilePathMenuPaths({
        path: "/Users/test/project",
        workspaceRoot: "/Users/test/project",
        homeDirectory: null,
      }),
    ).toEqual({ absolutePath: "/Users/test/project", relativePath: null, fileName: "project" });
  });
});
