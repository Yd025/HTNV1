import * as Sentry from '@sentry/nextjs';
import { installGameRecording } from './lib/sentryGame';
import { gameDataCollection, stripPrivateEventData, traceSampleRate } from './lib/sentryPrivacy';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    sendDefaultPii: false,
    dataCollection: gameDataCollection,
    enableLogs: false,
    integrations: defaults => [
      // Retain the SDK's global exception/rejection handlers. Replace automatic
      // breadcrumbs and tracing so unrelated console/request data stays private.
      ...defaults.filter(integration => !['Breadcrumbs', 'BrowserTracing', 'HttpContext'].includes(integration.name)),
      Sentry.browserTracingIntegration({
        shouldCreateSpanForRequest: url => {
          try {
            const target = new URL(url, window.location.origin);
            return target.origin === window.location.origin && target.pathname !== '/api/learning/live';
          } catch { return false; }
        },
      }),
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
        block: ['canvas:not([data-sentry-game-canvas])'],
        networkCaptureBodies: false,
        networkDetailAllowUrls: [],
        networkDetailDenyUrls: [/.*/],
        networkRequestHeaders: [],
        networkResponseHeaders: [],
        beforeAddRecordingEvent(event) {
          // Keep only our explicitly selected attempt breadcrumbs. Console and
          // network details can contain data unrelated to gameplay. Canvas and
          // masked DOM events are handled separately by the recorder.
          if (event.type === 5) {
            if (event.data.tag !== 'breadcrumb') return null;
            const payload = event.data.payload;
            if (!payload || typeof payload !== 'object' || !('category' in payload) || payload.category !== 'game.attempt') return null;
          }
          return event;
        },
      }),
      Sentry.replayCanvasIntegration({ enableManualSnapshot: true, quality: 'medium', maxCanvasSize: [960, 540] }),
    ],
    // Recording begins only when the player starts an opening attempt.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    tracesSampleRate: traceSampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE),
    tracePropagationTargets: [/^\/api\/learning\//],
    beforeBreadcrumb: breadcrumb => breadcrumb.category === 'game.attempt' ? breadcrumb : null,
    beforeSend: stripPrivateEventData,
    beforeSendTransaction: stripPrivateEventData,
  });
  installGameRecording();
}
