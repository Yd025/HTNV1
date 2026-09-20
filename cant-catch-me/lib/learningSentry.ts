import { createHash } from 'node:crypto';
import { LEGACY_RULES_VERSION, OVERHEAD_RULES_VERSION, COORDINATED_RULES_VERSION, RULES_VERSION, WORLD_VERSION, type AttemptSummary, type ControlSample, type Layout } from './learningTypes';

export const SENTRY_ATTACHMENT_NAME = 'cant-catch-me-opening-v1.json';
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export type SentryAttemptRecord = {
  schema: 1; kind: 'cant-catch-me.opening-attempt'; rulesVersion: string; worldVersion: string;
  attemptId: string; seed: number; ticks: number; controls: ControlSample[]; layout: Layout;
  summary: Pick<AttemptSummary, 'endedAt' | 'outcome' | 'seconds' | 'firstDetectionSeconds' | 'verified'>;
  replayId?: string;
};
export type SentryTransport = {
  configured: boolean; uploadConfigured: boolean; configurationMessage: string; destination: string | null;
  replayUrl(replayId: string): string | undefined;
  resolveProject?(): Promise<void>;
  publish(record: SentryAttemptRecord, eventId: string): Promise<void>;
  download(eventId: string): Promise<string | null>;
};
export class SentrySyncError extends Error {
  constructor(message: string, public awaitingIndex = false) { super(message); this.name = 'SentrySyncError'; }
}
export const sentryEventId = (attemptId: string) => createHash('sha256').update(`cant-catch-me:sentry-v1:${attemptId}`).digest('hex').slice(0, 32);
export const recordingHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Whitelist fields: session credentials, user identity and live payloads never leave the game server. */
export function sentryRecord(source: { id: string; seed: number; ticks: number; controls: ControlSample[]; layout: Layout; summary: AttemptSummary; rulesVersion?: string; worldVersion?: string }): SentryAttemptRecord {
  const { endedAt, outcome, seconds, firstDetectionSeconds, verified } = source.summary;
  return {
    schema: 1, kind: 'cant-catch-me.opening-attempt', rulesVersion: source.rulesVersion ?? RULES_VERSION, worldVersion: source.worldVersion ?? WORLD_VERSION,
    attemptId: source.id, seed: source.seed, ticks: source.ticks,
    controls: source.controls.map(({ tick, throttle, steer }) => ({ tick, throttle, steer })),
    layout: { version: source.layout.version, createdAt: source.layout.createdAt, reason: source.layout.reason,
      ...(source.layout.algorithm ? { algorithm: source.layout.algorithm } : {}),
      ...(source.layout.flightPolicy ? { flightPolicy: { ...source.layout.flightPolicy } } : {}),
      towers: source.layout.towers.map(({ id, x, z }) => ({ id, x, z })) },
    summary: { endedAt, outcome, seconds, firstDetectionSeconds, verified },
    ...(source.summary.sentry?.replayId ? { replayId: source.summary.sentry.replayId } : {}),
  };
}

/** Import only the exact, versioned recording already verified by game physics. */
export function importSentryRecord(text: string, expected: SentryAttemptRecord): SentryAttemptRecord {
  if (typeof text !== 'string') throw new SentrySyncError('Sentry returned an invalid recording.');
  if (Buffer.byteLength(text) > MAX_ATTACHMENT_BYTES) throw new SentrySyncError('Sentry recording exceeds the allowed size.');
  let value: SentryAttemptRecord;
  try { value = JSON.parse(text) as SentryAttemptRecord; } catch { throw new SentrySyncError('Sentry returned an invalid recording.'); }
  if (!value || value.schema !== 1 || value.kind !== 'cant-catch-me.opening-attempt'
    || ![RULES_VERSION, COORDINATED_RULES_VERSION, OVERHEAD_RULES_VERSION, LEGACY_RULES_VERSION].includes(value.rulesVersion) || value.rulesVersion !== expected.rulesVersion
    || value.worldVersion !== WORLD_VERSION || value.worldVersion !== expected.worldVersion
    || recordingHash(text) !== recordingHash(JSON.stringify(expected))) {
    throw new SentrySyncError('Sentry recording did not match the verified attempt.');
  }
  return value;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) throw new SentrySyncError('Sentry response exceeds the allowed size.');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.length;
      if (bytes > limit) { await reader.cancel(); throw new SentrySyncError('Sentry response exceeds the allowed size.'); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Official Sentry envelope + attachment APIs, with credentials confined to the server. */
export function createSentryTransport(env: Record<string, string | undefined> = process.env, request: typeof fetch = fetch): SentryTransport {
  const dsn = env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN, token = env.SENTRY_API_TOKEN;
  const apiBase = env.SENTRY_API_BASE || 'https://sentry.io';
  let ingestion: URL | null = null, normalizedDsn = '', configurationMessage = '', destination: string | null = null;
  let dsnOrgId = '', dsnProjectId = '';
  try {
    const url = new URL(dsn || '');
    if (url.protocol !== 'https:' || url.password || url.port || !/^o\d+\.ingest(?:\.(?:us|de))?\.sentry\.io$/.test(url.hostname)
      || !/^[a-f0-9]{32}$/.test(url.username) || !/^\/\d+$/.test(url.pathname) || url.search || url.hash) throw new Error();
    normalizedDsn = url.toString();
    destination = `${url.hostname}${url.pathname}`;
    dsnOrgId = url.hostname.split('.')[0].slice(1); dsnProjectId = url.pathname.slice(1);
    ingestion = new URL(`/api${url.pathname}/envelope/`, url.origin);
    ingestion.searchParams.set('sentry_version', '7'); ingestion.searchParams.set('sentry_key', url.username);
  } catch { configurationMessage = 'Set a valid SENTRY_DSN or NEXT_PUBLIC_SENTRY_DSN to queue recordings in Sentry.'; }
  const org = env.SENTRY_ORG?.trim() || dsnOrgId, project = env.SENTRY_PROJECT?.trim() || dsnProjectId;
  const uploadConfigured = !!ingestion;
  const validOrg = /^[a-zA-Z0-9_-]+$/.test(org), validProject = /^[a-zA-Z0-9_-]+$/.test(project);
  const missing = [...(!validOrg ? ['SENTRY_ORG'] : []), ...(!validProject ? ['SENTRY_PROJECT'] : []), ...(!token ? ['server-only SENTRY_API_TOKEN with project:read'] : [])];
  if (uploadConfigured && missing.length) configurationMessage = `Upload enabled; set ${missing.join(', ')} to feed the model.`;
  if (uploadConfigured && !['https://sentry.io', 'https://us.sentry.io', 'https://de.sentry.io'].includes(apiBase)) configurationMessage = 'Upload enabled; SENTRY_API_BASE must be an official Sentry API origin before import.';
  const configured = !configurationMessage;
  const projectPath = `${apiBase}/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/`;
  const eventPath = (id: string) => `${projectPath}events/${id}/attachments/`;
  const call = async (url: string, init: RequestInit, limit = MAX_ATTACHMENT_BYTES) => {
    try {
      const response = await request(url, { ...init, signal: AbortSignal.timeout(10000), redirect: 'manual' });
      return { response, text: () => boundedText(response, limit) };
    } catch { throw new SentrySyncError('Sentry could not be reached; the saved recording will retry.'); }
  };
  const requireConfiguration = () => { if (!configured) throw new SentrySyncError(configurationMessage); };
  let resolvedOrgSlug: string | undefined, metadataExpiresAt = 0, metadataRetryAt = 0, metadataError: SentrySyncError | undefined;
  let resolving: Promise<void> | null = null;
  const resolveProject = async (): Promise<void> => {
    requireConfiguration();
    if (metadataExpiresAt > Date.now()) return;
    if (resolving) return resolving;
    if (metadataRetryAt > Date.now()) throw metadataError;
    const lookup = (async () => {
      try {
        const metadata = await call(projectPath, { headers: { Authorization: `Bearer ${token}` } }, 256 * 1024);
        if (!metadata.response.ok) throw new SentrySyncError(`Sentry project lookup returned ${metadata.response.status}. Check the read token's project access.`);
        let value: { id?: unknown; organization?: { id?: unknown; slug?: unknown } };
        try { value = JSON.parse(await metadata.text()); } catch { throw new SentrySyncError('Sentry returned invalid project metadata.'); }
        if (!value || String(value.id) !== dsnProjectId || String(value.organization?.id) !== dsnOrgId) throw new SentrySyncError('Sentry project metadata does not match the configured game destination.');
        const slug = value.organization?.slug;
        // An API ID is valid in the resource path, never a guessed UI hostname.
        resolvedOrgSlug = typeof slug === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && !/^\d+$/.test(slug) ? slug : undefined;
        metadataExpiresAt = Date.now() + 5 * 60 * 1000; metadataRetryAt = 0; metadataError = undefined;
      } catch (error) {
        resolvedOrgSlug = undefined; metadataExpiresAt = 0; metadataRetryAt = Date.now() + 10000;
        metadataError = error instanceof SentrySyncError ? error : new SentrySyncError('Sentry project lookup failed; replay links will remain unavailable.');
        throw metadataError;
      }
    })();
    resolving = lookup;
    try { await lookup; } finally { resolving = null; }
  };
  return {
    configured, uploadConfigured, destination, configurationMessage: configurationMessage || 'Sentry recording import is configured.',
    replayUrl: (id) => resolvedOrgSlug ? `https://${resolvedOrgSlug}.sentry.io/replays/${id}/` : undefined,
    resolveProject,
    async publish(record, eventId) {
      if (!uploadConfigured) throw new SentrySyncError(configurationMessage);
      const attachment = JSON.stringify(record);
      if (Buffer.byteLength(attachment) > MAX_ATTACHMENT_BYTES) throw new SentrySyncError('Recording exceeds the Sentry attachment size limit.');
      const event = JSON.stringify({ event_id: eventId, platform: 'javascript', level: 'info', logger: 'cant-catch-me.learning',
        timestamp: record.summary.endedAt, message: 'Cant Catch Me opening attempt', fingerprint: ['cant-catch-me-opening-attempt'],
        tags: { 'game.attempt_id': record.attemptId, 'game.layout_version': String(record.layout.version), 'game.outcome': record.summary.outcome,
          'game.rules_version': record.rulesVersion, 'game.world_version': record.worldVersion, ...(record.replayId ? { replayId: record.replayId } : {}) },
        contexts: { game: { attempt_id: record.attemptId, layout_version: record.layout.version, capture_seconds: record.summary.seconds },
          ...(record.replayId ? { replay: { replay_id: record.replayId } } : {}) } });
      const envelope = [JSON.stringify({ event_id: eventId, dsn: normalizedDsn }), JSON.stringify({ type: 'event', length: Buffer.byteLength(event) }), event,
        JSON.stringify({ type: 'attachment', length: Buffer.byteLength(attachment), filename: SENTRY_ATTACHMENT_NAME, content_type: 'application/json', attachment_type: 'event.attachment' }), attachment, ''].join('\n');
      const { response } = await call(ingestion!.toString(), { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' }, body: envelope });
      if (!response.ok) throw new SentrySyncError(`Sentry upload returned ${response.status}; the saved recording will retry.`);
    },
    async download(eventId) {
      requireConfiguration();
      await resolveProject();
      const authorization = { Authorization: `Bearer ${token}` };
      const listing = await call(eventPath(eventId), { headers: authorization }, 256 * 1024);
      if (listing.response.status === 404) return null;
      if (!listing.response.ok) throw new SentrySyncError(`Sentry attachment access returned ${listing.response.status}. Check project:read and attachment access.`);
      let attachments: unknown;
      try { attachments = JSON.parse(await listing.text()); } catch { throw new SentrySyncError('Sentry returned an invalid attachment list.'); }
      if (!Array.isArray(attachments)) throw new SentrySyncError('Sentry returned an invalid attachment list.');
      const attachment = attachments.find((item) => item && item.name === SENTRY_ATTACHMENT_NAME && /^\d+$/.test(String(item.id)));
      if (!attachment) return null;
      if (typeof attachment.size === 'number' && attachment.size > MAX_ATTACHMENT_BYTES) throw new SentrySyncError('Sentry recording exceeds the allowed size.');
      let download = await call(`${eventPath(eventId)}${encodeURIComponent(String(attachment.id))}/?download=1`, { headers: authorization });
      // The documented download may redirect to cloud storage. Follow a bounded
      // HTTPS chain without carrying the Sentry bearer token to the storage host.
      for (let hop = 0; [301, 302, 303, 307, 308].includes(download.response.status) && hop < 3; hop++) {
        const location = download.response.headers.get('location');
        let target: URL;
        try { target = new URL(location || '', download.response.url || eventPath(eventId)); } catch { throw new SentrySyncError('Sentry download returned an invalid redirect.'); }
        if (!location || target.protocol !== 'https:' || target.username || target.password || target.port
          || !(target.hostname === 'sentry.io' || target.hostname.endsWith('.sentry.io') || target.hostname === 'storage.googleapis.com'
            || target.hostname.endsWith('.storage.googleapis.com') || target.hostname.endsWith('.amazonaws.com'))) throw new SentrySyncError('Sentry download returned an unsupported storage redirect.');
        download = await call(target.toString(), {});
      }
      if (download.response.status === 404) return null;
      if (!download.response.ok) throw new SentrySyncError(`Sentry recording download returned ${download.response.status}; it will retry.`);
      return download.text();
    },
  };
}
