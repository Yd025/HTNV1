import * as Sentry from "@sentry/nextjs";
import { browserDsn, sampleRate } from "./lib/sentry";

if (browserDsn) {
  Sentry.init({
    dsn: browserDsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    sendDefaultPii: false,
    enableLogs: true,
    tracesSampler: ({ name }) => name === "sentry.verify" ? 1 : sampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0.1),
    integrations: [Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })],
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}
