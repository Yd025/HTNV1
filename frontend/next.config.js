const { withSentryConfig } = require("@sentry/nextjs/config");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["three", "@react-three/fiber", "@react-three/drei"],
  experimental: { instrumentationHook: true },
};

module.exports = withSentryConfig(nextConfig, {
  org: "hackthenorth-nt",
  project: "htn",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
});
