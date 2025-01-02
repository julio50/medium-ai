from openai import OpenAI
import re
from app.config.config_files import OpenAIConfig

client = OpenAI(
    api_key=OpenAIConfig.api_key,
    base_url=OpenAIConfig.base_url,
)


def remove_newlines_and_spaces(string):
    pattern = r"\s+$"
    return re.sub(pattern, "", string)


def remove_quotes(string):
    """
    remove single and double quotes from the extreme ends of the string
    """
    pattern = r"^['\"]|['\"]$"
    return re.sub(pattern, "", string)


def edit_text_chat_completion(
    instruction: str,
    selected_text: str,
    temperature: float,
):
    response = client.chat.completions.create(
        model=OpenAIConfig.model,
        messages=[
            {
                "role": "system",
                "content": "You are a helpful assistant to a writer. ONLY edit the text as instructed.",
            },
            {
                "role": "user",
                "content": "Edit the following text: "
                f"{selected_text}" + "\n" + f"{instruction}",
            },
        ],
        temperature=temperature / 100,
    )

    response_text = response.choices[0].message.content

    # post processing
    response_text = remove_newlines_and_spaces(response_text)
    response_text = response_text.replace("\t", "")
    response_text = remove_quotes(response_text)

    return response_text


def edit_text(instruction: str, selected_text: str, temperature: float):
    response = client.chat.completions.create(
        model=OpenAIConfig.model,
        messages=[
            {
                "role": "system",
                "content": "You are a helpful assistant to a writer. ONLY edit the text as instructed. Return plain text.",
            },
            {
                "role": "user",
                "content": "Edit the following text: "
                f"{selected_text}" + "\n" + f"{instruction}",
            },
        ],
        temperature=temperature / 100,
    )

    # remove /n and spaces from the end of the response
    response_text = response.choices[0].message.content
    response_text = remove_newlines_and_spaces(response_text)

    # remove /t from the response
    response_text = response_text.replace("\t", "")

    return response_text
