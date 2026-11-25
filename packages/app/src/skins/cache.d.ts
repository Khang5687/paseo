// Metro resolves `./cache` to `cache.web.ts` or `cache.native.ts`. This file gives TypeScript
// (and any tool without platform resolution) the shared public surface; both platform files
// export exactly these names.
export * from "./cache.native";
