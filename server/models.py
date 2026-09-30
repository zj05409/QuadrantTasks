"""Pydantic models for the sync document."""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


class TaskItem(BaseModel):
    id: str = Field(min_length=1)
    title: str = ""
    note: str = ""
    quadrant: int = 0
    isDone: bool = False
    createdAt: str
    completedAt: Optional[str] = None
    updatedAt: str
    deleted: bool = False

    @field_validator("quadrant")
    @classmethod
    def quadrant_range(cls, v: int) -> int:
        if v not in (0, 1, 2, 3):
            return 0
        return v


class TaskDocument(BaseModel):
    revision: int = 0
    updatedAt: str
    tasks: List[TaskItem] = Field(default_factory=list)


class TasksPayload(BaseModel):
    tasks: List[Dict[str, Any]] = Field(default_factory=list)
    mode: Literal["merge", "replace"] = "merge"


class RegisterPayload(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    inviteCode: str = Field(min_length=1, max_length=200)
