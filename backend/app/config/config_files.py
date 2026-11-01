import os
import logging
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
