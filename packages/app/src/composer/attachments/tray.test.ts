import { describe, expect, it } from "vitest";
import { resolveAttachmentTrayLayout } from "./tray";

describe("resolveAttachmentTrayLayout", () => {
  it("keeps the labelled cards on wide layouts, however many files", () => {
    expect(resolveAttachmentTrayLayout({ compact: false, count: 1 })).toBe("cards");
    expect(resolveAttachmentTrayLayout({ compact: false, count: 12 })).toBe("cards");
  });

  it("draws one row of tiles on the phone up to four files", () => {
    expect(resolveAttachmentTrayLayout({ compact: true, count: 1 })).toBe("tiles");
    expect(resolveAttachmentTrayLayout({ compact: true, count: 4 })).toBe("tiles");
  });

  it("folds the phone tray into one chip past four files", () => {
    expect(resolveAttachmentTrayLayout({ compact: true, count: 5 })).toBe("chip");
    expect(resolveAttachmentTrayLayout({ compact: true, count: 30 })).toBe("chip");
  });
});
