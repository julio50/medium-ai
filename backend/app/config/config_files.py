
import os
import logging
from dotenv import load_dotenv, find_dotenv

logging.basicConfig(level=logging.DEBUG)

dotenv_path = find_dotenv()
logging.debug(f"Found .env file at: {dotenv_path}")
load_dotenv(dotenv_path)

logging.debug("Environment variables after loading .env:")
logging.debug(f"OPENAI_API_KEY present: {bool(os.getenv('OPENAI_API_KEY'))}")
logging.debug(f"OPENAI_BASE_URL: {os.getenv('OPENAI_BASE_URL')}")
logging.debug(f"OPENAI_MODEL: {os.getenv('OPENAI_MODEL')}")

class OpenAIConfig:
    api_key: str = os.getenv("OPENAI_API_KEY")
    base_url: str = os.getenv("OPENAI_BASE_URL")
    model: str = os.getenv("OPENAI_MODEL")

    @classmethod
    def validate(cls):
        if not cls.base_url:
            raise ValueError("OPENAI_BASE_URL is not set")
        if not cls.model:
            raise ValueError("OPENAI_MODEL is not set")
        if not cls.api_key:
            raise ValueError("OPENAI_API_KEY is not set")

# Validate config at startup
OpenAIConfig.validate()
