import type { Event } from "@sentry/nextjs";
import type { Options } from "@sentry/core";

export const dashboardDataCollection: NonNullable<Options["dataCollection"]> = {
  userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
  graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
  databaseQueryData: false, stackFrameVariables: false,
};

export const dashboardBreadcrumb = (category: string | undefined) => category === "navigation" || category === "simulator.camera";

/** Keep bounded mission context and diagnostics, never request credentials or raw state. */
export function stripPrivateEventData<T extends Event>(event: T): T {
  delete event.request;
  delete event.user;
  delete event.extra;
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.filter(item => dashboardBreadcrumb(item.category));
  return event;
}

export const privateServerIntegrations = new Set([
  "Console", "LocalVariables", "RequestData", "ChildProcess", "ConversationId",
  "OpenAI", "Anthropic_AI", "Google_GenAI", "LangChain", "LangGraph", "VercelAI",
]);
