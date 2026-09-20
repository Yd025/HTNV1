import * as Sentry from '@sentry/nextjs';
import { gameDataCollection, stripPrivateEventData, traceSampleRate } from './lib/sentryPrivacy';

const dsn = process.env.SENTRY_DSN?.trim() || process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE || undefined,
    sendDefaultPii: false,
    dataCollection: gameDataCollection,
    includeLocalVariables: false,
    integrations: defaults => defaults.filter(integration => ![
      'Console', 'LocalVariables', 'RequestData', 'ChildProcess', 'ConversationId',
      'OpenAI', 'Anthropic_AI', 'Google_GenAI', 'LangChain', 'LangGraph', 'VercelAI',
    ].includes(integration.name)),
    enableLogs: false,
    maxBreadcrumbs: 0,
    tracesSampleRate: traceSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    beforeSend: stripPrivateEventData,
    beforeSendTransaction: stripPrivateEventData,
  });
}
