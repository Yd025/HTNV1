"""Huawei openJiuwen-style multi-agent DAG for WHITEOUT intercepts.

This is not a prompt chain. Specialists run in parallel against a shared
blackboard, call tools (coverage query, sector proposal), and a fusion node
resolves conflicting recommendations into one intercept the MAVLink bridge
can actuate.

Swap the LLM backend without touching the graph:
  LLM_PROVIDER=openai   -> OpenAI API prize
  LLM_PROVIDER=gemini   -> MLH Gemini prize
  later: JiuwenSwarm / WorkSwarm  https://github.com/openJiuwen-ai/jiuwenswarm
"""

from __future__ import annotations

import json
import logging
import math
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

import sentry_sdk

logger = logging.getLogger("overwatch.dag")

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openai").lower()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

# Arctic WHITEOUT default — Resolute Bay area. Agents plan relative to this.
ARENA = {"lat": 74.6973, "lon": -94.8297, "label": "WHITEOUT sector alpha"}


@dataclass
class AgentMessage:
    sender: str
    recipient: str
    kind: str
    body: dict[str, Any]
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class Blackboard:
    """Shared working memory. Agents read/write; they do not pipe hidden prompts."""

    def __init__(self) -> None:
        self.fleet: dict[str, Any] = {}
        self.target: dict[str, Any] | None = None
        self.inbox: list[AgentMessage] = []
        self.proposals: dict[str, dict[str, Any]] = {}

    def post(self, message: AgentMessage) -> None:
        self.inbox.append(message)

    def dump(self) -> dict[str, Any]:
        return {
            "fleet": self.fleet,
            "target": self.target,
            "proposals": self.proposals,
            "messages": [m.__dict__ for m in self.inbox[-12:]],
        }


class Toolbelt:
    """Tools the swarm is allowed to call. Keep these side-effect free except plan emit."""

    def query_coverage(self, fleet: dict[str, Any]) -> dict[str, Any]:
        fixes = [v for v in fleet.values() if v.get("lat") is not None]
        return {
            "vehicles_reporting": len(fixes),
            "vehicles_total": len(fleet),
            "holes": [] if fixes else ["no GPS fixes yet — SITL still booting"],
        }

    def propose_offset(self, target: dict[str, Any], north_m: float, east_m: float) -> dict[str, float]:
        # 1 deg lat ~ 111_111 m; lon shrinks by cos(lat). Routing geometry only.
        lat = float(target.get("lat", ARENA["lat"]))
        lon = float(target.get("lon", ARENA["lon"]))
        dlat = north_m / 111_111.0
        dlon = east_m / (111_111.0 * max(0.2, abs(math.cos(math.radians(lat)))))
        return {"lat": lat + dlat, "lon": lon + dlon}


class LLMClient(Protocol):
    async def complete(self, system: str, user: str) -> str: ...


class HeuristicLLM:
    """Offline fallback so the stack demos without API keys."""

    async def complete(self, system: str, user: str) -> str:
        return json.dumps(
            {
                "intent": "hold_and_close",
                "rationale": "Heuristic fallback (no LLM key). Close from the north-east and keep a rover on the ice road.",
                "confidence": 0.35,
            }
        )


class OpenAILLM:
    def __init__(self) -> None:
        from openai import AsyncOpenAI

        self.client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.model = OPENAI_MODEL

    async def complete(self, system: str, user: str) -> str:
        with sentry_sdk.start_span(op="llm.openai", name=self.model):
            resp = await self.client.chat.completions.create(
                model=self.model,
                temperature=0.2,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
        return resp.choices[0].message.content or "{}"


class GeminiLLM:
    def __init__(self) -> None:
        import google.generativeai as genai

        genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
        self.model = genai.GenerativeModel(GEMINI_MODEL)

    async def complete(self, system: str, user: str) -> str:
        import asyncio

        prompt = f"{system}\n\n---\n\n{user}"
        with sentry_sdk.start_span(op="llm.gemini", name=GEMINI_MODEL):
            resp = await asyncio.to_thread(self.model.generate_content, prompt)
        return getattr(resp, "text", None) or "{}"


def build_llm() -> LLMClient:
    if LLM_PROVIDER == "openai" and os.getenv("OPENAI_API_KEY"):
        return OpenAILLM()
    if LLM_PROVIDER == "gemini" and os.getenv("GEMINI_API_KEY"):
        return GeminiLLM()
    # Prefer whichever key exists if provider is unset/mismatched.
    if os.getenv("OPENAI_API_KEY"):
        return OpenAILLM()
    if os.getenv("GEMINI_API_KEY"):
        return GeminiLLM()
    logger.warning("No LLM key; DAG using heuristic fallback")
    return HeuristicLLM()


class SpecialistAgent:
    role: str
    vehicle_class: str

    def __init__(self, llm: LLMClient, tools: Toolbelt):
        self.llm = llm
        self.tools = tools

    async def act(self, board: Blackboard) -> dict[str, Any]:
        coverage = self.tools.query_coverage(board.fleet)
        target = board.target or {"lat": ARENA["lat"], "lon": ARENA["lon"], "note": "predicted/default"}
        intercept = self._geometry(target)
        raw = await self.llm.complete(
            system=(
                f"You are the {self.role} for Operation Overwatch (WHITEOUT). "
                "Return compact JSON with keys: intercept_lat, intercept_lon, alt_m, "
                "rationale, confidence. Stay inside the Arctic arena. Do not invent estimators."
            ),
            user=json.dumps(
                {
                    "role": self.role,
                    "vehicle_class": self.vehicle_class,
                    "coverage": coverage,
                    "target": target,
                    "seed_intercept": intercept,
                    "peer_messages": [m.body for m in board.inbox if m.sender != self.role][-4:],
                }
            ),
        )
        proposal = _parse_json(raw)
        proposal.setdefault("intercept_lat", intercept["lat"])
        proposal.setdefault("intercept_lon", intercept["lon"])
        proposal.setdefault("alt_m", intercept.get("alt", 40.0))
        proposal["agent"] = self.role
        proposal["vehicle_class"] = self.vehicle_class
        board.proposals[self.role] = proposal
        board.post(
            AgentMessage(
                sender=self.role,
                recipient="fusion",
                kind="proposal",
                body=proposal,
            )
        )
        return proposal

    def _geometry(self, target: dict[str, Any]) -> dict[str, float]:
        raise NotImplementedError


class FixedWingAgent(SpecialistAgent):
    """Airborne tracker: stand-off intercept, keep altitude, cover the downwind line."""

    role = "fixed_wing"
    vehicle_class = "plane"

    def _geometry(self, target: dict[str, Any]) -> dict[str, float]:
        pt = self.tools.propose_offset(target, north_m=180.0, east_m=-80.0)
        pt["alt"] = 90.0
        return pt


class RoverAgent(SpecialistAgent):
    """Ground interceptor: ice-road constrained, zero altitude, close the last mile."""

    role = "rover"
    vehicle_class = "rover"

    def _geometry(self, target: dict[str, Any]) -> dict[str, float]:
        pt = self.tools.propose_offset(target, north_m=40.0, east_m=20.0)
        pt["alt"] = 0.0
        return pt


class FusionAgent:
    """Resolves air vs ground proposals into role advice — not MAVLink gotos."""

    def __init__(self, llm: LLMClient):
        self.llm = llm

    async def fuse(self, board: Blackboard) -> dict[str, Any]:
        raw = await self.llm.complete(
            system=(
                "You are Overwatch fusion. Merge heterogeneous proposals into role advice. "
                "JSON keys: assigned_vehicle, intercept_lat, intercept_lon, rationale. "
                "Do not emit MAVLink commands. Allocator and behavior trees fly the fleet."
            ),
            user=json.dumps(board.dump()),
        )
        plan = _parse_json(raw)
        air = board.proposals.get("fixed_wing", {})
        ground = board.proposals.get("rover", {})
        lat = float(plan.get("intercept_lat") or air.get("intercept_lat") or ARENA["lat"])
        lon = float(plan.get("intercept_lon") or ground.get("intercept_lon") or ARENA["lon"])
        return {
            "assigned_vehicle": plan.get("assigned_vehicle", "heterogeneous-split"),
            "intercept": {"lat": lat, "lon": lon},
            "rationale": plan.get("rationale")
            or air.get("rationale")
            or "Advisor only: search plane, cue towers, copter tracks, rover confirms.",
            "role_bias": {
                "plane": "search",
                "copter": "track",
                "rover": "confirm",
            },
            "blackboard": board.dump(),
            "ts": datetime.now(timezone.utc).isoformat(),
        }


class OverwatchDAG:
    """Slow advisor. The 10 Hz brain + behavior trees fly the fleet.

    ingest_state
        ├─► FixedWingAgent
        └─► RoverAgent
                └─► FusionAgent ► role_bias / rationale  (NOT lat/lon gotos)
    """

    def __init__(self) -> None:
        llm = build_llm()
        tools = Toolbelt()
        self.fixed_wing = FixedWingAgent(llm, tools)
        self.rover = RoverAgent(llm, tools)
        self.fusion = FusionAgent(llm)

    async def advise(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        """Role/sector advice only. Allocator + BTs still own actuation."""
        with sentry_sdk.start_span(op="dag.advise", name="role_bias"):
            fleet = snapshot.get("fleet") or {}
            track = snapshot.get("track")
            board = Blackboard()
            board.fleet = fleet
            board.target = track or _infer_target(fleet)
            await _gather_specialists(self.fixed_wing, self.rover, board)
            fused = await self.fusion.fuse(board)
            return {
                "role_bias": {
                    "plane": "search" if not track else "track",
                    "copter": "track" if track else "search",
                    "rover": "confirm" if track else "reserve",
                },
                "rationale": fused.get("rationale"),
                "intercept": fused.get("intercept") or (track and {"lat": track.get("lat"), "lon": track.get("lon")}),
                "blackboard": board.dump(),
                "ts": datetime.now(timezone.utc).isoformat(),
            }

    async def run(self, fleet: dict[str, Any], target: dict[str, Any] | None = None) -> dict[str, Any]:
        """Back-compat wrapper used by /strategy/run — still advice, not commands."""
        return await self.advise({"fleet": fleet, "track": target})


async def _gather_specialists(air: SpecialistAgent, ground: SpecialistAgent, board: Blackboard) -> None:
    import asyncio

    await asyncio.gather(air.act(board), ground.act(board))


def _infer_target(fleet: dict[str, Any]) -> dict[str, Any]:
    """Until a classifier lands, treat the noisiest / last-seen contact as the track."""
    for sample in fleet.values():
        if sample.get("lat") is not None:
            return {
                "lat": sample["lat"],
                "lon": sample["lon"],
                "source": "last_vehicle_fix",
                "note": "Replace with WHITEOUT target track when the sim publishes it.",
            }
    return {"lat": ARENA["lat"], "lon": ARENA["lon"], "source": "arena_origin"}


def _parse_json(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end > start:
            return json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        logger.warning("LLM JSON parse failed: %s", raw[:240])
    return {}
