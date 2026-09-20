import * as Sentry from "@sentry/nextjs";
import { browserDsn, sampleRate } from "./lib/sentry";
import { dashboardBreadcrumb, dashboardDataCollection, stripPrivateEventData } from "./lib/sentryPrivacy";

if (browserDsn) {
  Sentry.init({
    dsn: browserDsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    sendDefaultPii: false,
    dataCollection: dashboardDataCollection,
    enableLogs: true,
    tracesSampler: ({ name }) => name === "sentry.verify" ? 1 : sampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0.1),
    integrations: defaults => [
      ...defaults.filter(integration => !["Breadcrumbs", "HttpContext"].includes(integration.name)),
      Sentry.replayIntegration({
        maskAllText: true, maskAllInputs: true, blockAllMedia: true,
        block: ["canvas:not([data-sentry-native-canvas])"],
        networkCaptureBodies: false, networkDetailAllowUrls: [], networkDetailDenyUrls: [/.*/],
        networkRequestHeaders: [], networkResponseHeaders: [],
        beforeAddRecordingEvent(event) {
          if (event.type === 5) {
            if (event.data.tag !== "breadcrumb") return null;
            const payload = event.data.payload;
            if (!payload || typeof payload !== "object" || !("category" in payload)
              || typeof payload.category !== "string" || !dashboardBreadcrumb(payload.category)) return null;
          }
          return event;
        },
      }),
      Sentry.replayCanvasIntegration({ enableManualSnapshot: true, quality: "medium", maxCanvasSize: [960, 540] }),
    ],
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    beforeBreadcrumb: breadcrumb => dashboardBreadcrumb(breadcrumb.category) ? breadcrumb : null,
    beforeSend: stripPrivateEventData,
    beforeSendTransaction: stripPrivateEventData,
  });
}
