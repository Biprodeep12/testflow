/**
 * Single source of truth: the extension bundles the dashboard's type module directly.
 * Types vanish at build time; nothing from the Next.js app lands in the bundle.
 */
export * from "../../../src/types/flow";
