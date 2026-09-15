import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingExcludes: {
    "/*": ["./.env", "./.env.*", "./.git/**/*", "./tests/**/*", "./test-results/**/*", "./playwright-report/**/*", "./bin/**/*", "./next.config.ts", "./README.md", "./playwright.config.ts", "./eslint.config.mjs", "./drizzle.config.json"],
  },
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }, { key: "X-Frame-Options", value: "DENY" }, { key: "Referrer-Policy", value: "same-origin" }, { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }] }];
  },
};
export default nextConfig;
