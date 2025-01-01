import os
import tiktoken
from openai import OpenAI
import logging
from app.services.ai_edit import remove_newlines_and_spaces
from app.config.config_files import OpenAIConfig

logging.basicConfig(level=logging.DEBUG)

logging.debug(f"Initializing OpenAI client with base_url: {OpenAIConfig.base_url}")
logging.debug(f"Using model: {OpenAIConfig.model}")
logging.debug(f"API key present: {bool(OpenAIConfig.api_key)}")

client = OpenAI(
    api_key=OpenAIConfig.api_key,
    base_url=OpenAIConfig.base_url,
)

logging.debug(f"OpenAI client initialized with base_url: {client.base_url}")

def num_tokens_from_string(string: str) -> int:
    """Returns the number of tokens in a text string."""
    # Always use text-curie-001 for token estimation
    encoding = tiktoken.encoding_for_model("text-curie-001")
    num_tokens = len(encoding.encode(string))
    return num_tokens

def clip_context(
    previous_context: str,
    current_context: str,
    next_context: str,
    max_tokens: int,
    max_length: int = 2048,
):
    """
    Combine and clip all the contexts to max_length.
    """
    # Always use text-curie-001 for tokenization
    model_name = "text-curie-001"
    if "davinci" in model_name:
        max_length = 4096

    # subtract max_tokens from max_length to account for the tokens in the current context
    max_length = max_length - max_tokens

    result = {"prompt": "", "suffix": ""}

    encoding = tiktoken.encoding_for_model(model_name)
    current_context_tokens = encoding.encode(current_context)
    if len(current_context_tokens) > max_length:
        current_context_tokens = current_context_tokens[
            len(current_context_tokens) - max_length :
        ]
        result["prompt"] = encoding.decode(current_context_tokens)
        return result
    else:
        previous_context_tokens = encoding.encode(previous_context)
        if len(previous_context_tokens) + len(current_context_tokens) > max_length:
            previous_context_tokens = previous_context_tokens[
                len(previous_context_tokens)
                + len(current_context_tokens)
                - max_length :
            ]
            result["prompt"] = encoding.decode(
                previous_context_tokens + current_context_tokens
            )

            return result

        next_context_tokens = encoding.encode(next_context)
        if (
            len(previous_context_tokens)
            + len(current_context_tokens)
            + len(next_context_tokens)
            > max_length
        ):
            next_context_tokens = next_context_tokens[
                : max_length
                - len(previous_context_tokens)
                - len(current_context_tokens)
            ]

            result["prompt"] = encoding.decode(
                previous_context_tokens + current_context_tokens
            )
            result["suffix"] = encoding.decode(next_context_tokens)

            return result

        result["prompt"] = previous_context + current_context
        result["suffix"] = next_context
        return result

def openai_completion(
    result: dict, max_tokens: int, model_name: str
):
    logging.debug(f"openai_completion - result: {result}, max_tokens: {max_tokens}, model_name: {model_name}")
    is_space_at_end = result["prompt"].endswith(" ")
    # getting better results if we remove space at the end
    prompt = result["prompt"].rstrip()

    suffix = result["suffix"].lstrip() if len(result["suffix"]) > 0 else ""
    input_text = suffix + prompt

    logging.debug(f"openai_completion - Sending request to {client.base_url}")
    logging.debug(f"openai_completion - Using model {model_name}")
    try:
        res = client.chat.completions.create(
            model=model_name,
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful assistant that completes text. DO NOT RETURN THE INPUT TEXT. Only provide the completion and not the input, do not explain or add any other text."
                },
                {
                    "role": "user",
                    "content": f"Complete this text: {input_text}"
                }
            ],
            max_tokens=max_tokens,
            temperature=0.2,
            stop=["\n"]
        )
        logging.debug(f"openai_completion - Request successful")
    except Exception as e:
        logging.error(f"openai_completion - Error making request: {str(e)}")
        raise e

    logging.debug(f"openai_completion - OpenAI API response: {res}")
    res_text = res.choices[0].message.content

    # post processing

    # remove new lines and spaces from the end of the autocomplete response
    res_text = remove_newlines_and_spaces(res_text)
    # remove tabs from the autocomplete response
    res_text = res_text.replace("\t", "")

    if is_space_at_end:
        res_text = res_text.lstrip()

    return res_text

def fetch_autocomplete_response(
    previous_context: str,
    current_context: str,
    next_context: str,
    min_tokens: int = 3,
    max_tokens: int = 64,
):
    """
    Parameters
    -----------

    previous_context: str
        The text that comes before the current context.
    current_context: str
        The current text being typed by the user.
    next_context: str
        The text that comes after the current context.
    min_tokens: int
        minimum number of tokens required to trigger the autocomplete response.
    max_tokens: int
        maximum number of tokens the model will return in the autocomplete response.
    """
    model_name = OpenAIConfig.model
    logging.debug(
        f"fetch_autocomplete_response - "
        f"previous_context: '{previous_context}', "
        f"current_context: '{current_context}', "
        f"next_context: '{next_context}', "
        f"min_tokens: {min_tokens}, "
        f"max_tokens: {max_tokens}"
    )
    parsed_context = clip_context(
        previous_context,
        current_context,
        next_context,
        max_tokens=max_tokens,
    )
    logging.debug(f"fetch_autocomplete_response - parsed_context: {parsed_context}")
    text_total = parsed_context["prompt"] + parsed_context["suffix"]
    n_tokens = num_tokens_from_string(text_total)
    logging.debug(f"fetch_autocomplete_response - n_tokens: {n_tokens}")

    logging.debug(f"fetch_autocomplete_response - OpenAIConfig.base_url: {OpenAIConfig.base_url}")
    logging.debug(f"fetch_autocomplete_response - OpenAIConfig.model: {OpenAIConfig.model}")
    
    # Always try to get a completion regardless of token count
    autocomplete_text = openai_completion(
        parsed_context, max_tokens=max_tokens, model_name=model_name
    )
    return autocomplete_text
