import * as Sentry from "@sentry/nextjs";
import { sampleRate } from "./lib/sentry";
import { dashboardDataCollection, privateServerIntegrations, stripPrivateEventData } from "./lib/sentryPrivacy";

const dsn = process.env.SENTRY_DSN?.trim() || process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE || undefined,
    sendDefaultPii: false,
    dataCollection: dashboardDataCollection,
    includeLocalVariables: false,
    integrations: defaults => defaults.filter(integration => !privateServerIntegrations.has(integration.name)),
    maxBreadcrumbs: 0,
    enableLogs: true,
    tracesSampleRate: sampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
    beforeSend: stripPrivateEventData,
    beforeSendTransaction: stripPrivateEventData,
  });
}
