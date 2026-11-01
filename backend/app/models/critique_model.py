from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class Lens(BaseModel):
    """An angle to review the writing from. The backend knows nothing about
    specific lenses: the name and instruction come from the client."""

    name: str = Field(max_length=200)
    instruction: str


class Critique(BaseModel):
    # the document's paragraphs, in order (the model sees all of them)
    paragraphs: List[str]
    # indexes of the paragraphs to comment on (default: all of them); the rest are context
    targets: Optional[List[int]] = None
    lens: Lens
    modelName: Optional[str] = None
    thinking: bool = False  # legacy on/off (on = high)
    thinkingLevel: Optional[Literal["off", "low", "medium", "high"]] = None
