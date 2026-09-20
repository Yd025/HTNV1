import type { NextApiRequest, NextApiResponse } from 'next';
import { getLearningService, LearningError } from '../../../lib/learningServer';

/** Same-origin game session API. The dashboard consumes read-only aggregate data. */
export default async function handler(request: NextApiRequest, response: NextApiResponse) {
  response.setHeader('Cache-Control', 'no-store');
  const action = request.query.action;
  if (typeof action !== 'string' || !['start', 'live', 'finish', 'dashboard', 'layout', 'replay'].includes(action)) return response.status(404).json({ error: 'Unknown learning resource.' });
  const method = ['dashboard', 'layout', 'replay'].includes(action) ? 'GET' : 'POST';
  if (request.method !== method) { response.setHeader('Allow', method); return response.status(405).json({ error: `Use ${method}.` }); }
  if (method === 'POST' && request.headers.origin) {
    try {
      if (new URL(request.headers.origin).host !== request.headers.host) return response.status(403).json({ error: 'Use the game origin for recording attempts.' });
    } catch { return response.status(403).json({ error: 'Invalid request origin.' }); }
  }
  try {
    const service = getLearningService();
    if (action === 'start') return response.status(200).json(await service.start(request.body));
    if (action === 'live') return response.status(200).json(await service.live(request.body));
    if (action === 'finish') return response.status(200).json(await service.finish(request.body));
    if (action === 'replay') return response.status(200).json(await service.replay(request.query.attemptId));
    const dashboard = await service.dashboard();
    return response.status(200).json(action === 'layout' ? { layout: dashboard.layout, rulesVersion: dashboard.rulesVersion, worldVersion: dashboard.worldVersion } : dashboard);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Learning service is unavailable.';
    return response.status(error instanceof LearningError ? error.status : 503).json({ error: message });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '4mb' }, responseLimit: '8mb' } };
