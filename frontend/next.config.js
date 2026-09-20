const { withSentryConfig } = require("@sentry/nextjs/config");
const sentryOrg = process.env.SENTRY_ORG?.trim();
const sentryProject = process.env.SENTRY_PROJECT?.trim();
const sentryBuildToken = process.env.SENTRY_AUTH_TOKEN?.trim();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  transpilePackages: ["three", "@react-three/fiber", "@react-three/drei"],
  experimental: { instrumentationHook: true },
};

module.exports = withSentryConfig(nextConfig, {
  ...(sentryOrg ? { org: sentryOrg } : {}),
  ...(sentryProject ? { project: sentryProject } : {}),
  ...(sentryBuildToken ? { authToken: sentryBuildToken } : {}),
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: { disable: !(sentryOrg && sentryProject && sentryBuildToken) },
});
