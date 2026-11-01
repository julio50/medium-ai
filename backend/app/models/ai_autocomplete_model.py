from typing import Literal, Optional
from pydantic import BaseModel


class AIAutoSuggest(BaseModel):
    previousContext: str
    currentContext: str
    nextContext: str
    modelName: Optional[str] = None
    thinking: bool = False  # legacy on/off (on = high)
    thinkingLevel: Optional[Literal["off", "low", "medium", "high"]] = None
    # explicit request (Ctrl+Space): suggest even with little context
    force: bool = False
