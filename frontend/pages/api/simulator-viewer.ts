import type { NextApiRequest, NextApiResponse } from "next";
import { prepareSimulatorViewerHtml, simulatorViewerUrls } from "../../lib/simulatorViewer";

function errorPage(message: string) {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulator unavailable</title></head><body style="margin:0;padding:32px;background:#11161b;color:#e6edf3;font:16px/1.6 system-ui,sans-serif"><h1 style="font-size:20px">Simulator world unavailable</h1><p>${escaped}</p><p>Check the simulator connection, then reload the world.</p></body></html>`;
}

/** Fixed-upstream, GET-only HTML adapter. Simulation and mission sockets remain native. */
export default async function handler(request: NextApiRequest, response: NextApiResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).send(errorPage("This viewer accepts read-only GET requests."));
  }

  const address = process.env.SIM_VIEWER_URL ?? process.env.NEXT_PUBLIC_SIM_VIEWER_URL ?? "http://127.0.0.1:8080";
  const controlAddress = process.env.NEXT_PUBLIC_SIM_CONTROL_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const { viewer } = simulatorViewerUrls(address, controlAddress);
    // Redirects could silently change the asset/socket origin. The configured
    // endpoint must be the native viewer page, not a login or redirect page.
    const upstream = await fetch(viewer.href, { signal: controller.signal, cache: "no-store", redirect: "error" });
    if (!upstream.ok) {
      return response.status(502).send(errorPage(`The simulator viewer returned HTTP ${upstream.status}.`));
    }
    if (!upstream.headers.get("content-type")?.toLowerCase().includes("text/html")) {
      return response.status(502).send(errorPage("The simulator did not return an HTML viewer page."));
    }
    const html = prepareSimulatorViewerHtml(await upstream.text(), viewer.href, controlAddress);
    return response.status(200).send(html);
  } catch (error) {
    const message = controller.signal.aborted
      ? "The simulator viewer did not respond within 8 seconds."
      : error instanceof Error && /^(The simulator|The simulator control)/.test(error.message)
        ? error.message
        : "The simulator viewer could not be reached.";
    return response.status(503).send(errorPage(message));
  } finally {
    clearTimeout(timeout);
  }
}
