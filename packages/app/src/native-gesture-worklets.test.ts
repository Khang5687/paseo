import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";

// The worklets Babel plugin turns gesture callbacks into worklets and builds each closure
// from the callback's free variables when the gesture is created, so a DOM global named in
// a callback is read at render. On Android and iOS that render throws
// "Property 'document' doesn't exist" (the composer resize grip did this). Compile every
// file that builds a gesture the way Metro does for Android and check what the closures read.

const appDir = fileURLToPath(new URL("..", import.meta.url));
const srcDir = path.join(appDir, "src");
const DOM_GLOBALS = new Set(["document", "window", "navigator", "localStorage", "HTMLElement"]);
const GESTURE_BUILDER = /\bGesture\.(Pan|Tap|Hover|Pinch|LongPress|Fling|Rotation|Manual)\(/;

function gestureSources(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|web|electron)\.|\.d\.ts$/.test(file))
    .map((file) => path.join(srcDir, file))
    .filter((file) => GESTURE_BUILDER.test(readFileSync(file, "utf8")));
}

function workletClosureNames(file: string): string[] {
  const result = transformSync(readFileSync(file, "utf8"), {
    cwd: appDir,
    filename: file,
    caller: { name: "metro", bundler: "metro", platform: "android" },
    envName: "production",
  });
  const names = [...(result?.code ?? "").matchAll(/\.__closure=\{([^}]*)\}/g)].flatMap((match) =>
    match[1].split(",").map((entry) => entry.split(":")[0].trim()),
  );
  return [...new Set(names)];
}

describe("native gesture worklets", () => {
  const files = gestureSources();

  it("finds the gesture files", () => {
    expect(files.some((file) => file.endsWith("composer/input/resize-grip.tsx"))).toBe(true);
  });

  it.each(files.map((file) => [path.relative(appDir, file), file]))(
    "%s: no gesture callback captures a DOM global",
    (_name, file) => {
      const captured = workletClosureNames(file).filter((name) => DOM_GLOBALS.has(name));
      expect(captured).toEqual([]);
    },
  );
});
