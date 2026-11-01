from typing import Literal, Optional
from pydantic import BaseModel


class AIEdit(BaseModel):
    instruction: str
    selectedText: str
    temperature: float = 0.2
    modelName: Optional[str] = None
    thinking: bool = False  # legacy on/off (on = high)
    thinkingLevel: Optional[Literal["off", "low", "medium", "high"]] = None


class Tidy(BaseModel):
    transcript: str
    modelName: Optional[str] = None
    thinking: bool = False  # legacy on/off (on = high)
    thinkingLevel: Optional[Literal["off", "low", "medium", "high"]] = None
