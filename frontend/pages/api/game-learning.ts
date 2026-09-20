import type { NextApiRequest, NextApiResponse } from "next";

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Read-only bridge to the separate game; never touches the mission simulator. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Only GET is supported." });
  }
  const attemptId = req.query.attemptId;
  const replay = attemptId !== undefined;
  if (replay && (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId))) {
    return res.status(400).json({ error: "Choose a valid saved attempt to replay." });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), replay ? 20000 : 5000);
  try {
    const endpoint = new URL(replay ? "/api/learning/replay" : "/api/learning/dashboard", process.env.GAME_SERVICE_URL || "http://127.0.0.1:3100");
    if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("Invalid game service URL");
    if (typeof attemptId === "string") endpoint.searchParams.set("attemptId", attemptId);
    const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store", redirect: "error" });
    if (replay && (response.status === 404 || response.status === 429)) {
      controller.abort();
      return res.status(response.status).json({ error: response.status === 404
        ? "This saved attempt is no longer available to replay. Choose another attempt."
        : "Saved replays are busy right now. Try again in a moment." });
    }
    if (!response.ok || !response.body) throw new Error("Game service unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Game response too large");
      }
      chunks.push(value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return res.status(200).json(payload);
  } catch {
    return res.status(502).json({ error: "Cannot reach the game service. Start cant-catch-me or check GAME_SERVICE_URL, then retry." });
  } finally {
    clearTimeout(timeout);
  }
}
