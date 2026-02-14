"""API routes for nozzle temperature history."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.nozzle_history import NozzleTempHistory
from backend.app.models.user import User

router = APIRouter(prefix="/nozzle-temp-history", tags=["nozzle-temp-history"])


class NozzleTempHistoryPoint(BaseModel):
    recorded_at: datetime
    nozzle_left: float | None
    nozzle_right: float | None


class NozzleTempHistoryResponse(BaseModel):
    printer_id: int
    data: list[NozzleTempHistoryPoint]
    min_left: float | None
    max_left: float | None
    avg_left: float | None
    min_right: float | None
    max_right: float | None
    avg_right: float | None


@router.get("/{printer_id}", response_model=NozzleTempHistoryResponse)
async def get_nozzle_temp_history(
    printer_id: int,
    hours: float = Query(default=24, ge=0.5, le=168, description="Hours of history (0.5-168)"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.NOZZLE_HISTORY_READ),
):
    """Get nozzle temperature history for a printer (dual-nozzle only)."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    result = await db.execute(
        select(NozzleTempHistory)
        .where(
            and_(
                NozzleTempHistory.printer_id == printer_id,
                NozzleTempHistory.recorded_at >= since,
            )
        )
        .order_by(NozzleTempHistory.recorded_at)
    )
    records = result.scalars().all()

    stats_result = await db.execute(
        select(
            func.min(NozzleTempHistory.nozzle_left).label("min_left"),
            func.max(NozzleTempHistory.nozzle_left).label("max_left"),
            func.avg(NozzleTempHistory.nozzle_left).label("avg_left"),
            func.min(NozzleTempHistory.nozzle_right).label("min_right"),
            func.max(NozzleTempHistory.nozzle_right).label("max_right"),
            func.avg(NozzleTempHistory.nozzle_right).label("avg_right"),
        ).where(
            and_(
                NozzleTempHistory.printer_id == printer_id,
                NozzleTempHistory.recorded_at >= since,
            )
        )
    )
    stats = stats_result.one()

    return NozzleTempHistoryResponse(
        printer_id=printer_id,
        data=[
            NozzleTempHistoryPoint(
                recorded_at=r.recorded_at,
                nozzle_left=r.nozzle_left,
                nozzle_right=r.nozzle_right,
            )
            for r in records
        ],
        min_left=stats.min_left,
        max_left=stats.max_left,
        avg_left=round(stats.avg_left, 1) if stats.avg_left else None,
        min_right=stats.min_right,
        max_right=stats.max_right,
        avg_right=round(stats.avg_right, 1) if stats.avg_right else None,
    )
