"""System API schemas."""

from pydantic import BaseModel


class DeleteStorageItemRequest(BaseModel):
    """Request to delete storage items."""

    category_keys: list[str] = []
    """Category keys to delete (e.g., 'archive_timelapses', 'downloads')."""

    other_items: list[dict] = []
    """Other items to delete, each with 'bucket' and 'kind' keys."""

    cleanup_db_objects: bool = True
    """Whether to remove/update DB records linked to deleted files."""

    class Config:
        """Pydantic config."""

        json_schema_extra = {
            "example": {
                "category_keys": ["archive_timelapses", "downloads"],
                "other_items": [{"bucket": "some_folder", "kind": "data"}],
                "cleanup_db_objects": True,
            }
        }


class DeleteStorageItemResponse(BaseModel):
    """Response from storage deletion."""

    success: bool
    """Whether the deletion was fully successful."""

    deleted_count: int
    """Number of files/directories deleted."""

    deleted_bytes: int
    """Total bytes freed."""

    errors: list[str] = []
    """List of errors encountered during deletion."""

    message: str
    """Human-readable status message."""
