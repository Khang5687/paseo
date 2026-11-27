import { describe, expect, it } from "vitest";
import { filePanelCatalog, MEDIA_PREVIEW_MAX_BYTES } from "./catalog";
import { resolveFilePanel, type FilePanelCandidate, type FilePanelFile } from "./resolve";

const builtins = filePanelCatalog([]);

const richMarkdown: FilePanelCandidate = {
  id: "plugin:notes/rich",
  builtin: false,
  files: { extensions: ["md"] },
};

function textFile(path: string): FilePanelFile {
  return { path, kind: "text" };
}

function candidateIds(file: FilePanelFile, candidates: readonly FilePanelCandidate[] = builtins) {
  return resolveFilePanel({ file, candidates, associations: {} }).candidates.map(
    (candidate) => candidate.id,
  );
}

function panelId(file: FilePanelFile, candidates: readonly FilePanelCandidate[] = builtins) {
  return resolveFilePanel({ file, candidates, associations: {} }).panel?.id ?? null;
}

describe("built-in file panels", () => {
  it("opens each rendered extension with its panel alone, never with Source beside it", () => {
    expect(candidateIds(textFile("README.md"))).toEqual(["builtin:markdown"]);
    expect(candidateIds(textFile("plan.html"))).toEqual(["builtin:html"]);
    expect(panelId(textFile("notes.markdown"))).toBe("builtin:markdown");
    expect(panelId(textFile("plan.html"))).toBe("builtin:html");
    expect(panelId(textFile("docs/PLAN.HTML"))).toBe("builtin:html");
    expect(panelId(textFile("plan.htm"))).toBe("builtin:html");
  });

  it("opens every other text file with Source, whatever its name", () => {
    for (const path of ["src/index.ts", "page.mdx", "index.html.erb", "Dockerfile", "LICENSE"]) {
      expect(candidateIds(textFile(path))).toEqual(["builtin:source"]);
    }
  });

  it("puts plugin panels after the built-in that claims the file, and before Source", () => {
    expect(candidateIds(textFile("README.md"), filePanelCatalog([richMarkdown]))).toEqual([
      "builtin:markdown",
      richMarkdown.id,
    ]);
    const onlyPlugin = filePanelCatalog([{ ...richMarkdown, files: { extensions: ["txt"] } }]);
    expect(candidateIds(textFile("notes.txt"), onlyPlugin)).toEqual([
      richMarkdown.id,
      "builtin:source",
    ]);
    expect(panelId(textFile("notes.txt"), onlyPlugin)).toBe(richMarkdown.id);
  });

  it("ignores a remembered Source for a file another built-in claims", () => {
    const resolution = resolveFilePanel({
      file: textFile("README.md"),
      candidates: builtins,
      associations: { "ext:md": "builtin:source" },
    });
    expect(resolution.panel?.id).toBe("builtin:markdown");
    expect(resolution.associatedPanelId).toBeNull();
  });

  it("has no Source for files that are not text", () => {
    expect(candidateIds({ path: "archive.zip", kind: "binary" })).toEqual([]);
  });

  it.each(["png", "jpg", "jpeg", "gif", "webp", "svg"])(
    "registers the image extension %s",
    (extension) => {
      const resolution = resolveFilePanel({
        file: { path: `/capture.${extension.toUpperCase()}`, kind: "image" },
        candidates: builtins,
        associations: { [`ext:${extension}`]: "builtin:markdown" },
      });
      expect(resolution.panel?.id).toBe("builtin:image");
      expect(
        resolveFilePanel({
          file: { path: "capture.png", kind: "binary" },
          candidates: builtins,
          associations: {},
        }).panel,
      ).toBeNull();
    },
  );

  it.each([
    ...["mp4", "mov", "webm", "m4v"].map((extension) => [extension, "builtin:video"]),
    ...["mp3", "m4a", "wav", "ogg", "aac", "flac"].map((extension) => [extension, "builtin:audio"]),
    ["pdf", "builtin:pdf"],
  ])("opens a binary .%s file with %s", (extension, id) => {
    const file = { path: `/out/clip.${extension.toUpperCase()}`, kind: "binary", size: 1 } as const;
    expect(candidateIds(file)).toEqual([id]);
    expect(resolveFilePanel({ file, candidates: builtins, associations: {} }).oversized).toBe(
      false,
    );
  });

  it.each(["clip.mp4", "song.mp3", "report.pdf"])(
    "opens %s with Download once it is over the media size cap",
    (path) => {
      const atCap = { path, kind: "binary", size: MEDIA_PREVIEW_MAX_BYTES } as const;
      expect(panelId(atCap)).not.toBeNull();
      const resolution = resolveFilePanel({
        file: { ...atCap, size: MEDIA_PREVIEW_MAX_BYTES + 1 },
        candidates: builtins,
        associations: {},
      });
      expect(resolution.panel).toBeNull();
      expect(resolution.oversized).toBe(true);
    },
  );

  it("keeps a plugin panel for a media file over the cap", () => {
    const player: FilePanelCandidate = {
      id: "plugin:player/video",
      builtin: false,
      files: { extensions: ["mp4"] },
    };
    const file = { path: "clip.mp4", kind: "binary", size: MEDIA_PREVIEW_MAX_BYTES * 2 } as const;
    expect(panelId(file, filePanelCatalog([player]))).toBe(player.id);
  });

  it("offers no PDF panel on a device that cannot embed PDFs", () => {
    const file = { path: "report.pdf", kind: "binary", size: 1 } as const;
    expect(panelId(file, filePanelCatalog([], { inlinePdf: false }))).toBeNull();
    expect(panelId({ ...file, path: "clip.mp4" }, filePanelCatalog([], { inlinePdf: false }))).toBe(
      "builtin:video",
    );
  });
});
