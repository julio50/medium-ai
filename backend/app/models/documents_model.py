from typing import Any, Dict, Optional
from pydantic import BaseModel, Field


class DocumentIn(BaseModel):
    """The editor's stored format: {version, timestamp, state}."""

    version: str = "1.0"
    # ms since epoch: when the content was last edited (newer wins)
    timestamp: Optional[int] = None
    # serialized Lexical editor state ({"root": {...}})
    state: Dict[str, Any]
    # a title chosen by the user (default: derived from the first heading / line)
    title: Optional[str] = Field(default=None, max_length=300)


class SearchRequest(BaseModel):
    # the document to search: every search is within exactly one document
    document_key: str
    query: str = Field(max_length=10000)
    k: int = Field(default=20, ge=1, le=100)
    # false: keyword search only
    semantic: bool = True
