from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base


class NozzleTempHistory(Base):
    """Historical temperature data for dual-nozzle printers."""

    __tablename__ = "nozzle_temp_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"))
    nozzle_left: Mapped[float | None] = mapped_column(Float)
    nozzle_right: Mapped[float | None] = mapped_column(Float)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        index=True,
    )

    __table_args__ = (Index("ix_nozzle_temp_printer_time", "printer_id", "recorded_at"),)

    printer: Mapped["Printer"] = relationship(back_populates="nozzle_temp_history")


from backend.app.models.printer import Printer  # noqa: E402
