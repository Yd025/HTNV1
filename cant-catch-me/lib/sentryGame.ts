import * as Sentry from '@sentry/nextjs';
import { registerGameReplayHooks } from './learningClient';

const attempts = new Map<string, { replayId?: string; active: boolean }>();
let starting: Promise<void> | null = null;
let lastSnapshot = -Infinity;
let snapshotBusy = false;

function replayId(): string | undefined {
  const value = Sentry.getReplay()?.getReplayId(true)?.replace(/-/g, '').toLowerCase();
  return value && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
}

/** Register only after the browser SDK is initialized; no player credentials enter Sentry. */
export function installGameRecording(): void {
  registerGameReplayHooks({
    start(attemptId, layoutVersion) {
      const replay = Sentry.getReplay();
      if (!replay) return;
      const attempt = { replayId: replayId(), active: true };
      attempts.set(attemptId, attempt);
      while (attempts.size > 128) attempts.delete(attempts.keys().next().value!);
      const breadcrumb = () => Sentry.addBreadcrumb({
        category: 'game.attempt', message: 'Opening stretch started', level: 'info',
        data: { attemptId, layoutVersion },
      });
      if (attempt.replayId) { breadcrumb(); return; }
      if (!starting) {
        starting = Promise.resolve(replay.start()).then(() => undefined).catch(() => undefined).finally(() => { starting = null; });
      }
      void starting.then(() => {
        attempt.replayId = replayId();
        if (attempt.active && attempt.replayId) breadcrumb();
      });
    },
    finish(attemptId, outcome) {
      const attempt = attempts.get(attemptId);
      if (!attempt) return undefined;
      attempt.active = false;
      const id = attempt.replayId ?? replayId();
      attempts.delete(attemptId);
      if (!id) return undefined;
      Sentry.addBreadcrumb({ category: 'game.attempt', message: 'Opening stretch finished', level: 'info', data: { attemptId, outcome } });
      // Flush in the background. The game's durable control upload is independent
      // of video delivery and still works when Sentry is unavailable.
      void Sentry.getReplay()?.flush().catch(() => undefined);
      return id;
    },
  });
}

/** Called immediately after WebGL paints, before its drawing buffer is cleared. */
export function snapshotGameCanvas(canvas: HTMLCanvasElement): void {
  if (snapshotBusy || document.hidden || !canvas.hasAttribute('data-sentry-game-canvas')
    || ![...attempts.values()].some(attempt => attempt.active) || !replayId()) return;
  const now = performance.now();
  if (now - lastSnapshot < 500) return;
  const recorder = Sentry.getClient()?.getIntegrationByName<ReturnType<typeof Sentry.replayCanvasIntegration>>('ReplayCanvas');
  if (!recorder) return;
  lastSnapshot = now;
  snapshotBusy = true;
  try {
    void recorder.snapshot(canvas, { skipRequestAnimationFrame: true }).catch(() => undefined).finally(() => { snapshotBusy = false; });
  } catch { snapshotBusy = false; }
}
