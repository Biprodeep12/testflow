/**
 * Bundles the extension into extension/dist/ — the folder you "Load unpacked".
 *
 * Four entry points, no framework: esbuild is the whole toolchain.
 * Run from the repo root:  npm run build:ext
 */

import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");

await mkdir(dist, { recursive: true });

await build({
  entryPoints: {
    recorder: path.join(here, "src", "content", "recorder.ts"),
    "main-world": path.join(here, "src", "content", "main-world.ts"),
    bridge: path.join(here, "src", "content", "bridge.ts"),
    sw: path.join(here, "src", "sw", "index.ts"),
    popup: path.join(here, "src", "popup", "popup.ts"),
  },
  outdir: dist,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  logLevel: "info",
});

await copyFile(path.join(here, "manifest.json"), path.join(dist, "manifest.json"));
await copyFile(
  path.join(here, "src", "popup", "popup.html"),
  path.join(dist, "popup.html"),
);

console.log(`[build:ext] extension ready in extension/dist`);
