import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  reactStrictMode: true,

  /**
   * Leave firebase-admin out of the server bundle.
   *
   * It resolves its subpaths (`firebase-admin/auth`, `/firestore`) through
   * conditional exports and dynamic requires, and gRPC/protobufjs load files at
   * runtime. Bundling that works locally — where node_modules is present either
   * way — and then fails on a platform that ships only what the bundler traced:
   * the module throws while being EVALUATED, before any handler runs, so the
   * route never gets to return its JSON envelope and Next serves its HTML 500
   * page instead. That is exactly the shape of the production failure: every
   * route importing the auth helper died, while /api/health (firestore only)
   * kept working.
   *
   * Marking it external makes Next emit a plain require() and lets the host
   * trace the real package — the arrangement Firebase documents for Next.js.
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
