import { withSentryConfig } from '@sentry/nextjs/config';

const sentryOrg = process.env.SENTRY_ORG?.trim();
const sentryProject = process.env.SENTRY_PROJECT?.trim();
const sentryBuildToken = process.env.SENTRY_AUTH_TOKEN?.trim();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep validation builds separate from a running development server.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  experimental: { instrumentationHook: true },
};
export default withSentryConfig(nextConfig, {
  ...(sentryOrg ? { org: sentryOrg } : {}),
  ...(sentryProject ? { project: sentryProject } : {}),
  ...(sentryBuildToken ? { authToken: sentryBuildToken } : {}),
  telemetry: false,
  silent: true,
  // Readback's SENTRY_API_TOKEN never authorizes build artifact uploads.
  sourcemaps: { disable: !(sentryOrg && sentryProject && sentryBuildToken) },
});
