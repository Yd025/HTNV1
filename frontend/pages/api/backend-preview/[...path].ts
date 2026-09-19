import type { NextApiRequest, NextApiResponse } from "next";

/** Same-origin, GET-only preview proxy. The controller has no write path here. */
export default async function handler(request: NextApiRequest, response: NextApiResponse) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Read-only preview" });
  }
  const segments = request.query.path;
  if (!Array.isArray(segments)) return response.status(404).end();
  const route = segments.join("/");
  const simulatorRoute = /^simulator\/(site|assets|status)$/.test(route);
  if (!simulatorRoute && route !== "health" && route !== "cameras" && !/^cameras\/[a-zA-Z0-9_-]+\/snapshot\.jpg$/.test(route)) {
    return response.status(404).json({ error: "Unknown preview resource" });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), simulatorRoute ? 6000 : 2500);
  try {
    const base = simulatorRoute ? process.env.SIM_CONTROL_URL ?? "http://127.0.0.1:8090" : process.env.BACKEND_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";
    const upstreamPath = simulatorRoute ? `api/${segments[1]}` : route;
    const upstream = await fetch(`${base.replace(/\/$/, "")}/${upstreamPath}`, { signal: controller.signal, cache: "no-store" });
    response.setHeader("Cache-Control", "no-store");
    if (upstream.status === 204) return response.status(204).end();
    if (!upstream.ok) return response.status(upstream.status).json({ error: "Backend resource unavailable" });
    response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
    return response.status(200).send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    return response.status(503).json({ error: "Backend unavailable" });
  } finally {
    clearTimeout(timeout);
  }
}
