"""ElevenLabs radio brief — give the command center a voice after each intercept plan."""

from __future__ import annotations

import logging
import os
from typing import Any

import sentry_sdk

logger = logging.getLogger("overwatch.radio")

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "")


def script_from_plan(plan: dict[str, Any]) -> str:
    intercept = plan.get("intercept") or {}
    rationale = plan.get("rationale") or "holding pattern"
    return (
        f"Overwatch, Overwatch, this is fusion. "
        f"Intercept {intercept.get('lat', 0):.4f} north, {intercept.get('lon', 0):.4f} west. "
        f"{rationale} Out."
    )


async def speak_plan(plan: dict[str, Any]) -> dict[str, Any] | None:
    if not ELEVENLABS_API_KEY:
        return None
    text = script_from_plan(plan)
    try:
        from elevenlabs.client import AsyncElevenLabs

        client = AsyncElevenLabs(api_key=ELEVENLABS_API_KEY)
        with sentry_sdk.start_span(op="tts.elevenlabs", name="radio_brief"):
            audio = b"".join(
                [chunk async for chunk in client.text_to_speech.convert(
                    voice_id=ELEVENLABS_VOICE_ID or "JBFqnCBsd6RMkjVDRZzb",
                    text=text,
                    model_id="eleven_turbo_v2_5",
                )]
            )
        return {"mime": "audio/mpeg", "bytes": audio, "script": text}
    except Exception:
        logger.exception("ElevenLabs radio brief failed")
        sentry_sdk.capture_exception()
        return None
