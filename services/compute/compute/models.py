"""Pydantic request models and small domain errors for the public contract."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ComputeError(Exception):
    """An error whose body follows the compute service's documented shape."""

    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code

    def body(self) -> dict[str, dict[str, str]]:
        return {"error": {"code": self.code, "message": self.message}}


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1)


class ChatCompletionRequest(BaseModel):
    """The text-only subset of the OpenAI chat-completions request format."""

    model_config = ConfigDict(extra="ignore")

    model: str | None = None
    messages: list[ChatMessage] = Field(min_length=1)
    max_tokens: int | None = Field(default=128, ge=1)
    temperature: float | None = Field(default=None, ge=0, le=2)
    stream: bool = False


class BookingRequest(BaseModel):
    gpu_id: str
    slot_start: datetime
    slots: int = Field(ge=1, le=288)
    redemption_id: str = Field(min_length=1, max_length=200)
    holder: str = Field(min_length=1, max_length=200)

    @field_validator("slot_start")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("slot_start must be an ISO 8601 UTC timestamp")
        return value.astimezone(timezone.utc)


class UsageEvent(BaseModel):
    request_id: str
    gpu_id: str
    buyer: str
    booking_id: str | None
    input_tokens: int
    output_tokens: int
    charge: str
    started_at: datetime
    finished_at: datetime
    simulated: bool


class WorkerRegisterRequest(BaseModel):
    gpu_id: str
    model: str | None = None
    tokens_per_sec: float | None = None
    simulated: bool | None = None
