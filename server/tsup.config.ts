import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Shared is a source-only workspace package, bundle it so `node dist/index.js`
  // does not have to understand TypeScript.
  noExternal: ["@oriel/shared"],
});
