"""Mission-command roles. LLM may bias copter/rover; it does not emit lat/lon.

Doctrine (find / fix / track / PID):
  plane  — ISR hunter, always search, never prosecute
  tower  — fixed OP, always cue
  copter — QRF, search until a qualified track, then custody
  rover  — reserve until track is solid, then confirm / PID
"""

from __future__ import annotations

from sim.types import Role, VehicleState
from tracker import Track

DEFAULT_ROLE: dict[str, Role] = {
    "plane": "search",
    "copter": "reserve",
    "rover": "reserve",
    "tower": "cue",
}


def assign_roles(
    vehicles: list[VehicleState],
    track: Track | None,
    advisor: dict | None = None,
) -> dict[str, Role]:
    roles: dict[str, Role] = {}
    have_track = bool(track and track.confidence >= 0.35 and track.hits >= 2)
    bias = (advisor or {}).get("role_bias") or {}

    for v in vehicles:
        if v.vehicle_class == "tower":
            roles[v.vehicle_id] = "cue"
            continue
        preferred = bias.get(v.vehicle_id) or bias.get(v.vehicle_class)
        if v.vehicle_class == "plane":
            roles[v.vehicle_id] = "search"
        elif v.vehicle_class == "copter":
            if have_track:
                roles[v.vehicle_id] = "track"
            else:
                roles[v.vehicle_id] = preferred if preferred in {"search", "reserve"} else "search"
        elif v.vehicle_class == "rover":
            roles[v.vehicle_id] = "confirm" if have_track and track and track.confidence >= 0.45 else "reserve"
        else:
            roles[v.vehicle_id] = DEFAULT_ROLE.get(v.vehicle_class, "reserve")

    # One searcher after custody exists: extra air searchers become the tracker.
    searchers = [vid for vid, r in roles.items() if r == "search"]
    if have_track and len(searchers) > 1:
        for vid in searchers:
            v = next((x for x in vehicles if x.vehicle_id == vid), None)
            if v and v.vehicle_class == "copter":
                roles[vid] = "track"
    return roles
