import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  reactStrictMode: true,

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
