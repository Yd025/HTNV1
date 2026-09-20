const { withSentryConfig } = require("@sentry/nextjs/config");
const { PHASE_DEVELOPMENT_SERVER } = require("next/constants");
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

module.exports = withSentryConfig((phase) => ({
  ...nextConfig,
  distDir: process.env.NEXT_DIST_DIR || (
    phase === PHASE_DEVELOPMENT_SERVER ? "node_modules/.cache/overwatch-dev" : ".next"
  ),
}), {
  ...(sentryOrg ? { org: sentryOrg } : {}),
  ...(sentryProject ? { project: sentryProject } : {}),
  ...(sentryBuildToken ? { authToken: sentryBuildToken } : {}),
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: { disable: !(sentryOrg && sentryProject && sentryBuildToken) },
});
