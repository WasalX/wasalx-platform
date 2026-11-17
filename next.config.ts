import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    // Scoped public receipt surface: no third-party scripts, analytics or sends.
    // Next's incumbent inline bootstrap/style remain allowed; this is not a
    // claim of nonce-based XSS protection or a whole-product CSP certificate.
    const values = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "no-store, max-age=0" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'" },
    ];
    return [{ source: "/privacy/meta-deletion", headers: values }, { source: "/api/meta-deletion/status", headers: values }];
  },
};

export default nextConfig;
