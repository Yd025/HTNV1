"""Tiger Data / TimescaleDB ingest for high-frequency MAVLink telemetry.

Stores raw samples in a hypertable and maintains a 1-second continuous aggregate
so the command center can chart lag-free series with ordinary SQL.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

try:
    import asyncpg
except ImportError:  # Persistence is optional for the controller and offline demo.
    asyncpg = None  # type: ignore[assignment]

logger = logging.getLogger("overwatch.db")

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://overwatch:overwatch@postgres:5432/overwatch",
)

_pool: asyncpg.Pool | None = None


TABLE_SQL = """
CREATE TABLE IF NOT EXISTS mavlink_telemetry (
    time                TIMESTAMPTZ     NOT NULL,
    vehicle_id          TEXT            NOT NULL,
    sysid               INTEGER,
    msg_type            TEXT            NOT NULL,
    lat                 DOUBLE PRECISION,
    lon                 DOUBLE PRECISION,
    alt                 DOUBLE PRECISION,
    heading             DOUBLE PRECISION,
    groundspeed         DOUBLE PRECISION,
    roll                DOUBLE PRECISION,
    pitch               DOUBLE PRECISION,
    battery_remaining   DOUBLE PRECISION,
    armed               BOOLEAN,
    mode                TEXT,
    payload             JSONB           NOT NULL DEFAULT '{}'::jsonb
);
"""

INDEX_SQL = """
CREATE INDEX IF NOT EXISTS mavlink_telemetry_vehicle_time_idx
    ON mavlink_telemetry (vehicle_id, time DESC);
"""

HYPERTABLE_SQL = """
SELECT create_hypertable(
    'mavlink_telemetry',
    'time',
    if_not_exists => TRUE,
    migrate_data => TRUE
);
"""

CAGG_SQL = """
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1s
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 second', time) AS bucket,
    vehicle_id,
    last(lat, time) AS lat,
    last(lon, time) AS lon,
    avg(alt) AS alt,
    avg(groundspeed) AS groundspeed,
    last(heading, time) AS heading,
    last(battery_remaining, time) AS battery_remaining
FROM mavlink_telemetry
GROUP BY bucket, vehicle_id
WITH NO DATA;
"""

CAGG_POLICY_SQL = """
SELECT add_continuous_aggregate_policy(
    'telemetry_1s',
    start_offset => INTERVAL '10 minutes',
    end_offset   => INTERVAL '1 second',
    schedule_interval => INTERVAL '1 second',
    if_not_exists => TRUE
);
"""

SCORE_SQL = """
CREATE TABLE IF NOT EXISTS whiteout_scores (
    time                TIMESTAMPTZ     NOT NULL,
    coverage            DOUBLE PRECISION,
    collaboration       DOUBLE PRECISION,
    efficiency          DOUBLE PRECISION,
    tracking            DOUBLE PRECISION,
    track_error_m       DOUBLE PRECISION,
    time_to_detect_s    DOUBLE PRECISION,
    meters_flown        DOUBLE PRECISION,
    commands_issued     INTEGER
);
"""

SCORE_HYPERTABLE_SQL = """
SELECT create_hypertable('whiteout_scores', 'time', if_not_exists => TRUE, migrate_data => TRUE);
"""


def enabled() -> bool:
    return bool(DATABASE_URL) and os.getenv("DATABASE_ENABLED", "1").lower() not in {"0", "false", "no"}


async def init_pool() -> asyncpg.Pool:
    global _pool
    if not enabled():
        raise RuntimeError("database is disabled")
    if asyncpg is None:
        raise RuntimeError("asyncpg is not installed")
    if _pool is None:
        _pool = await asyncpg.create_pool(
            DATABASE_URL, min_size=1, max_size=8,
            timeout=float(os.getenv("DB_TIMEOUT_SEC", "2")),
            command_timeout=float(os.getenv("DB_TIMEOUT_SEC", "2")),
        )
        logger.info("TimescaleDB pool ready")
    return _pool


async def close_pool() -> None:
    global _pool
    pool, _pool = _pool, None
    if pool is not None:
        try:
            await pool.close()
        except (asyncio.CancelledError, Exception):
            pool.terminate()
            raise


async def ensure_schema() -> None:
    pool = await init_pool()
    async with pool.acquire() as conn:
        await conn.execute(TABLE_SQL)
        await conn.execute(INDEX_SQL)
        try:
            await conn.execute(HYPERTABLE_SQL)
        except asyncpg.PostgresError as exc:
            logger.warning("create_hypertable skipped: %s", exc)
        try:
            await conn.execute(CAGG_SQL)
            await conn.execute(CAGG_POLICY_SQL)
        except asyncpg.PostgresError as exc:
            logger.warning("continuous aggregate skipped: %s", exc)
        await conn.execute(SCORE_SQL)
        try:
            await conn.execute(SCORE_HYPERTABLE_SQL)
        except asyncpg.PostgresError as exc:
            logger.warning("score hypertable skipped: %s", exc)


async def ping() -> bool:
    # Health reads must not create/retry connections or race the ingest worker.
    if _pool is None:
        return False
    try:
        async with asyncio.timeout(float(os.getenv("DB_TIMEOUT_SEC", "2"))):
            async with _pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
        return True
    except Exception:
        logger.debug("TimescaleDB ping failed", exc_info=True)
        return False


async def ingest_telemetry(sample: dict[str, Any]) -> None:
    """Single-row insert. Batch / COPY is the next performance step if Hz climbs."""
    pool = await init_pool()
    payload = sample.get("payload") or {}
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO mavlink_telemetry (
                time, vehicle_id, sysid, msg_type, lat, lon, alt,
                heading, groundspeed, roll, pitch, battery_remaining,
                armed, mode, payload
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12,
                $13, $14, $15::jsonb
            )
            """,
            sample.get("timestamp")
            or datetime.now(timezone.utc),
            sample.get("vehicle_id", "unknown"),
            sample.get("sysid"),
            sample.get("msg_type", "TELEMETRY"),
            sample.get("lat"),
            sample.get("lon"),
            sample.get("alt"),
            sample.get("heading"),
            sample.get("groundspeed"),
            sample.get("roll"),
            sample.get("pitch"),
            sample.get("battery_remaining"),
            sample.get("armed"),
            sample.get("mode"),
            json.dumps(payload),
        )


async def latest_positions(limit: int = 32) -> list[dict[str, Any]]:
    pool = await init_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT ON (vehicle_id)
                vehicle_id, time, lat, lon, alt, heading, groundspeed,
                battery_remaining, armed, mode
            FROM mavlink_telemetry
            WHERE lat IS NOT NULL AND lon IS NOT NULL
            ORDER BY vehicle_id, time DESC
            LIMIT $1
            """,
            limit,
        )
    return [dict(r) for r in rows]


async def ingest_score(score: dict[str, Any]) -> None:
    if not score:
        return
    pool = await init_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO whiteout_scores (
                time, coverage, collaboration, efficiency, tracking,
                track_error_m, time_to_detect_s, meters_flown, commands_issued
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            """,
            datetime.now(timezone.utc),
            score.get("coverage"),
            score.get("collaboration"),
            score.get("efficiency"),
            score.get("tracking"),
            score.get("track_error_m"),
            score.get("time_to_detect_s"),
            score.get("meters_flown"),
            score.get("commands_issued"),
        )
