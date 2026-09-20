import type { Event } from '@sentry/nextjs';
import type { Options } from '@sentry/core';

/** Disable sensitive categories explicitly; omitted collection fields default on. */
export const gameDataCollection: NonNullable<Options['dataCollection']> = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  stackFrameVariables: false,
};

/** Keep the stack and timing evidence while removing request and ad hoc player data. */
export function stripPrivateEventData<T extends Event>(event: T): T {
  delete event.request;
  delete event.user;
  delete event.extra;
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.filter(item => item.category === 'game.attempt');
  return event;
}

export function traceSampleRate(value: string | undefined): number {
  if (!value?.trim()) return 0.1;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.1;
}
