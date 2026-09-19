export const SENTRY_ORG = "hackthenorth-nt";
export const SENTRY_PROJECT = "htn";
export const SENTRY_BASE = `https://${SENTRY_ORG}.sentry.io`;
export const browserDsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() || undefined;

export function sampleRate(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : fallback;
}

export function sentryLink(view: "issues" | "logs" | "traces" | "replays", query?: string): string {
  const url = new URL(`/explore/${view === "traces" ? "traces/" : view === "logs" ? "logs/" : ""}`, SENTRY_BASE);
  if (view === "issues" || view === "replays") url.pathname = `/${view}/`;
  if (query) url.searchParams.set("query", query);
  // Sentry's project selector requires the numeric DSN project ID, not a slug.
  if (browserDsn) {
    try {
      const projectId = new URL(browserDsn).pathname.split("/").filter(Boolean).pop();
      if (projectId && /^\d+$/.test(projectId)) url.searchParams.set("project", projectId);
    } catch { /* Setup status remains available for a malformed DSN. */ }
  }
  return url.toString();
}
