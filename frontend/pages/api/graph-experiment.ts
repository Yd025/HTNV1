import type { NextApiRequest, NextApiResponse } from "next";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Job = { id: string; kind: "train" | "replay"; status: "running" | "complete" | "failed"; error?: string; directory: string; process?: ChildProcess };
const globalJobs = globalThis as typeof globalThis & { arcticGraphJobs?: Map<string, Job> };
const jobs = globalJobs.arcticGraphJobs ??= new Map<string, Job>();
const project = path.resolve(process.cwd(), "..");
const publicRoot = path.join(project, "frontend", "public", "experiments");
const script = path.join(project, "backend", "train_graph_search.py");
const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);

async function jsonFile(filename: string) { return JSON.parse(await readFile(filename, "utf8")); }
function pythonCommand() {
  if (process.env.GRAPH_PYTHON) return process.env.GRAPH_PYTHON;
  for (const filename of [path.join(project, ".venv", "Scripts", "python.exe"), path.join(project, ".venv", "bin", "python"), path.resolve(project, "..", "HTNV1-backend", ".venv", "Scripts", "python.exe")]) {
    if (existsSync(filename)) return filename;
  }
  return process.platform === "win32" ? "python" : "python3";
}

/** Bounded local experiments only. No simulator commands or configurable subprocess arguments. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method ?? "")) { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Use GET or POST." }); }
  const host = req.headers.host ?? "";
  let hostname = "";
  try { hostname = new URL(`http://${host}`).hostname; } catch { /* Invalid hosts are rejected below. */ }
  const remote = req.socket.remoteAddress ?? "";
  if (!loopback(hostname) || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return res.status(403).json({ error: "Training is available from this computer only." });
  if (req.method === "GET") {
    const latestTraining = req.query.latestTraining === "1";
    const id = latestTraining
      ? [...jobs.values()].reverse().find(item => item.kind === "train")?.id ?? ""
      : typeof req.query.id === "string" ? req.query.id : "";
    const job = jobs.get(id);
    if (latestTraining && !job) return res.status(200).json({ status: "idle" });
    if (!job) return res.status(404).json({ error: "This experiment is no longer available. Start a new run." });
    if (req.query.download === "result" || req.query.download === "model") {
      if (job.status !== "complete" || (req.query.download === "model" && job.kind !== "train")) return res.status(409).json({ error: "This download is not ready yet." });
      try {
        const isModel = req.query.download === "model";
        const value = await jsonFile(path.join(job.directory, isModel ? "model.json" : "result.json"));
        res.setHeader("Content-Disposition", `attachment; filename="${isModel ? "graph-model" : "graph-report"}.json"`);
        return res.status(200).json(value);
      } catch { return res.status(500).json({ error: "The result file could not be read." }); }
    }
    const payload: Record<string, unknown> = { id, kind: job.kind, status: job.status, error: job.error };
    try { payload.progress = await jsonFile(path.join(job.directory, "progress.json")); } catch { /* First progress write may not have happened yet. */ }
    if (job.status === "complete") {
      try { payload.result = await jsonFile(path.join(job.directory, "result.json")); }
      catch { return res.status(500).json({ error: "The experiment finished without a readable result. Start a new run." }); }
    }
    return res.status(200).json(payload);
  }
  let reserved: Job | undefined;
  try {
    if (req.headers.origin && new URL(req.headers.origin).host !== host) return res.status(403).json({ error: "Open the training page on this computer to run an experiment." });
    if (!req.headers["content-type"]?.startsWith("application/json")) return res.status(415).json({ error: "Send a JSON experiment request." });
    if ([...jobs.values()].some(job => job.status === "running")) return res.status(409).json({ error: "An experiment is already running. Wait for it to finish." });
    const body = req.body;
    if (!body || !["train", "replay"].includes(body.kind) || !Number.isInteger(body.seed) || body.seed < 0 || body.seed > 2147483647) return res.status(400).json({ error: "Choose a valid experiment and seed between 0 and 2147483647." });
    const kind = body.kind as Job["kind"];
    const algorithm = body.algorithm ?? (kind === "train" ? "coordinated-surveillance-v1" : "tower-first-v2");
    if (!["tower-first-v2", "coordinated-surveillance-v1"].includes(algorithm)) return res.status(400).json({ error: "Choose a supported surveillance algorithm." });
    const flightBounds: Record<string, [number, number]> = { laneSpacingM: [200, 1600], routePhase: [0, 1], quadSearchRadiusM: [250, 2200], lookaheadS: [0, 40], supportOffsetM: [100, 1000], reacquireWidthM: [50, 700] };
    if (body.flightPolicy !== undefined && (!body.flightPolicy || typeof body.flightPolicy !== "object" || Array.isArray(body.flightPolicy)
      || Object.keys(body.flightPolicy).some(key => !(key in flightBounds))
      || Object.entries(flightBounds).some(([key, [low, high]]) => typeof body.flightPolicy[key] !== "number" || !Number.isFinite(body.flightPolicy[key]) || body.flightPolicy[key] < low || body.flightPolicy[key] > high))) {
      return res.status(400).json({ error: "The flight policy is incomplete or outside its supported limits. Select a trained candidate again." });
    }
    const id = randomUUID();
    const directory = path.join(project, "frontend", ".graph-jobs", id);
    let model = path.join(publicRoot, algorithm === "coordinated-surveillance-v1" ? "surveillance-model.json" : "graph-model.json");
    if (body.modelJob) {
      const previous = jobs.get(String(body.modelJob));
      if (!previous || previous.kind !== "train" || previous.status !== "complete") return res.status(400).json({ error: "The selected trained model is unavailable. Reload the saved model." });
      model = path.join(previous.directory, "model.json");
    }
    const replay: Record<string, unknown> = { seed: body.seed, algorithm, ...(body.flightPolicy ? { flightPolicy: body.flightPolicy } : {}) };
    const validPoint = (p: unknown): p is { x: number; y: number } => !!p && typeof p === "object" && ["x", "y"].every(key => typeof (p as Record<string, unknown>)[key] === "number" && Number.isFinite((p as Record<string, number>)[key]) && Math.abs((p as Record<string, number>)[key]) <= 3250);
    if (body.boatStart !== undefined) {
      if (!validPoint(body.boatStart)) return res.status(400).json({ error: "Place the boat inside the Fort Ross map." });
      replay.boatStart = body.boatStart;
    }
    if (body.towers !== undefined) {
      if (!Array.isArray(body.towers) || body.towers.length !== 2 || !body.towers.every((t: unknown) => validPoint(t))) return res.status(400).json({ error: "Choose exactly two tower positions inside the map." });
      replay.towers = body.towers.map((tower: { x: number; y: number; heading?: number }, i: number) => ({ id: `tower-${i + 1}`, x: tower.x, y: tower.y, heading: typeof tower.heading === "number" && Number.isFinite(tower.heading) ? ((tower.heading % 360) + 360) % 360 : 0 }));
    }
    if (!existsSync(script)) return res.status(503).json({ error: "The training tools are unavailable in this installation." });
    // Reserve before the first await: simultaneous requests cannot both launch.
    const job: Job = { id, kind, status: "running", directory };
    jobs.set(id, job);
    reserved = job;
    await mkdir(directory, { recursive: true });
    const args = ["-B", script, "--output", path.join(directory, "result.json")];
    if (kind === "train") {
      args.push("--seed", String(body.seed), "--algorithm", algorithm, "--model-output", path.join(directory, "model.json"), "--progress", path.join(directory, "progress.json"));
      // Re-evaluate the saved settings alongside new candidates rather than
      // discarding them whenever the user starts another experiment.
      if (algorithm === "coordinated-surveillance-v1" && existsSync(model)) args.push("--initial-model", model);
    }
    else {
      await writeFile(path.join(directory, "request.json"), JSON.stringify(replay));
      args.push("--replay", path.join(directory, "request.json"), "--model", model);
    }
    // Replay history is bounded; retain trained model handles for later replays.
    if (jobs.size > 30) { const oldest = [...jobs.values()].find(item => item.id !== id && item.kind === "replay" && item.status !== "running"); if (oldest) jobs.delete(oldest.id); }
    const child = spawn(pythonCommand(), args, { cwd: path.join(project, "backend"), windowsHide: true, shell: false, env: { ...process.env, ADAPTER: "local", FORCE_KINEMATIC: "1", PYTHONUNBUFFERED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    job.process = child;
    let log = "";
    child.stdout?.on("data", value => { log = (log + value.toString()).slice(-16000); });
    child.stderr?.on("data", value => { log = (log + value.toString()).slice(-16000); });
    const timeout = setTimeout(() => { job.status = "failed"; job.error = "Training exceeded 30 minutes. The saved model is still available."; child.kill(); }, 30 * 60 * 1000);
    child.on("error", () => { clearTimeout(timeout); job.status = "failed"; job.error = "Python could not start. Set GRAPH_PYTHON to a Python environment with NumPy, then try again."; });
    child.on("close", code => {
      clearTimeout(timeout);
      if (job.status === "running") { job.status = code === 0 ? "complete" : "failed"; if (code !== 0) job.error = "The experiment failed. Check the local experiment log, then try again."; }
      job.process = undefined;
      void writeFile(path.join(directory, "run.log"), log).catch(() => {});
    });
    return res.status(202).json({ id, kind, status: job.status });
  } catch {
    if (reserved) { reserved.status = "failed"; reserved.error = "The experiment could not start."; }
    return res.status(500).json({ error: "The experiment could not start. Check the local Python configuration and try again." });
  }
}

export const config = { api: { bodyParser: { sizeLimit: "8kb" }, responseLimit: "20mb" } };
