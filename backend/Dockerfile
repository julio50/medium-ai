# Use official Python image
FROM python:3.9-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first to leverage Docker cache
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Environment variables will be provided by docker-compose from .env

# Expose port
EXPOSE 8080

# Run the application
CMD ["uvicorn", "app.api:app", "--host", "0.0.0.0", "--port", "8080", "--reload"]
