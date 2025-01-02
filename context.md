# Project Overview
medium-ai is an open-source AI-powered text editor inspired by Medium's design. It provides a rich text editing experience enhanced with AI capabilities for text autocompletion and editing. The project uses:

- Frontend: React, TypeScript, Lexical (text editor framework), DaisyUI/TailwindCSS
- Backend: Python, FastAPI
- AI Integration: OpenAI-compatible APIs (including LocalAI)

# Functionality
The editor provides these key features:

## Core Editor Features
- Rich text formatting
- Code blocks with syntax highlighting
- Mathematical equations using KaTeX
- Images and horizontal dividers
- Markdown shortcuts
- Floating toolbars for formatting

## AI Features
- **AI Autosuggestion**: Generates text continuations based on context
- **AI Edit**: Allows editing selected text through natural language instructions

## Other Features
- Editor state persistence
- Keyboard shortcuts (Ctrl+S to save)
- Multiple AI model selection
- LocalStorage support for saving documents in the browser

# Code Locations
## Backend
- **API Endpoints**: `backend/app/api.py`
  - /autocomplete - Handles AI text suggestions
  - /ai_edit - Processes text editing requests
  - /save_state, /load_state - Manages editor state persistence

## Frontend
- **Main Application**: `frontend/src/App.tsx`
  - Handles model selection and saving
- **Editor Implementation**: `frontend/src/Editor.tsx`
  - Core editor setup with Lexical
  - Plugin integration
- **AI Autocomplete**: 
  - Plugin: `frontend/src/plugins/AIAutoCompletePlugin/index.tsx`
  - Node: `frontend/src/nodes/AIAutoCompleteNode/index.tsx`
- **UI Components**:
  - MenuBar: `frontend/src/components/MenuBar.tsx`
  - Floating toolbars: `frontend/src/plugins/FloatingElements/`

# Dependencies
The project relies on:
- **Frontend**:
  - Lexical - Text editor framework
  - DaisyUI/TailwindCSS - UI styling
  - KaTeX - Math rendering
- **Backend**:
  - FastAPI - Web framework
  - Uvicorn - ASGI server
- **AI**:
  - OpenAI-compatible APIs
  - LocalAI for local model hosting
