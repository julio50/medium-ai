import os
import logging
from pathlib import Path
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())


class OpenAIConfig:
    # Local servers (llama-swap, LocalAI, Ollama) ignore the key, but the client requires one
    api_key: str = os.getenv("OPENAI_API_KEY") or "not-needed"
    base_url: str = os.getenv("OPENAI_BASE_URL", "http://192.168.1.158:8080/v1")
    model: str = os.getenv("OPENAI_MODEL", "spark-instruct")


logging.info(f"LLM server: {OpenAIConfig.base_url} (default model: {OpenAIConfig.model})")


class SpeechConfig:
    # speech-to-text model on the same server (whisper.cpp / parakeet / OpenAI)
    model: str = os.getenv("TRANSCRIBE_MODEL", "whisper-1")


class EmbeddingConfig:
    # embedding model on the same server, used for semantic search
    model: str = os.getenv("EMBEDDING_MODEL", "embedding")


class StorageConfig:
    # documents + search index (SQLite). Relative paths are relative to backend/.
    data_dir: Path = Path(os.getenv("DATA_DIR") or Path(__file__).resolve().parents[1] / "data")
    if not data_dir.is_absolute():
        data_dir = Path(__file__).resolve().parents[2] / data_dir
    # largest request body accepted (a whole book in one document is ~10-30 MB of JSON)
    max_request_mb: int = int(os.getenv("MAX_REQUEST_MB", "100"))
