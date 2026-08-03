import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  reactStrictMode: true,

  /**
   * Belt and braces, and nothing more — do not read this as the fix for the
   * plain-500 production failure. It was once believed to be, and it is not:
   *
   *   - `serverExternalPackages` only opts out of the bundling that
   *     `bundlePagesRouterDependencies` turns ON, and that defaults to false.
   *     This app is Pages Router, so its server dependencies were never
   *     bundled to begin with.
   *   - `firebase-admin` is already in Next's own built-in external list
   *     (next/dist/lib/server-external-packages.json).
   *
   * The build's file trace confirms it: the emitted route requires
   * firebase-admin, and the trace carries gRPC, protobufjs and the Firestore
   * .proto assets. Nothing was missing.
   *
   * The real cause was the Node version — firebase-admin@14 requires >=22 and
   * nothing declared it, so a host could build on an older runtime where the
   * module throws while being evaluated. See `engines` in package.json.
   *
   * Kept because it costs nothing and would still be correct if
   * bundlePagesRouterDependencies were ever switched on.
   */
  serverExternalPackages: ["firebase-admin"],

  headers() {
    return [
      {
        // A strict CSP, deliberately. Most real sites ship one, and `unsafe-eval`
        // is exactly what they leave out — which means anything the replayer does
        // via `new Function` or eval simply does not run there. This page exists so
        // that limitation is a test rather than a support ticket.
        source: "/demo-csp.html",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
