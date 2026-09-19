from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

import db


class DatabaseLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_ping_does_not_initialize_pool(self):
        with patch.object(db, "_pool", None), patch.object(db, "init_pool", AsyncMock()) as init:
            self.assertFalse(await db.ping())
            init.assert_not_called()

    async def test_cancelled_close_forgets_and_terminates_pool(self):
        pool = Mock(close=AsyncMock(side_effect=asyncio.CancelledError))
        with patch.object(db, "_pool", pool):
            with self.assertRaises(asyncio.CancelledError):
                await db.close_pool()
            self.assertIsNone(db._pool)
            pool.terminate.assert_called_once()

    async def test_disabled_or_missing_driver_is_explicit(self):
        with patch.dict("os.environ", {"DATABASE_ENABLED": "0"}):
            self.assertFalse(db.enabled())
            with self.assertRaisesRegex(RuntimeError, "disabled"):
                await db.init_pool()
        with patch.object(db, "enabled", return_value=True), patch.object(db, "asyncpg", None):
            with self.assertRaisesRegex(RuntimeError, "not installed"):
                await db.init_pool()


if __name__ == "__main__":
    unittest.main()
