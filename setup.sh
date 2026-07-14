#!/bin/bash
# Handsfree setup script
# Installs dependencies and checks configuration

set -e

echo "=== Handsfree Setup ==="
echo

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed."
    echo "Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "WARNING: Node.js version 18+ recommended (you have $(node -v))"
fi
echo "✓ Node.js $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "ERROR: npm is not installed."
    exit 1
fi
echo "✓ npm $(npm -v)"

# Check openssl (used to generate the self-signed HTTPS certificate)
if command -v openssl &> /dev/null; then
    echo "✓ openssl found (self-signed cert generates on first run)"
else
    echo "WARNING: openssl not found — the server can't generate its HTTPS"
    echo "  certificate, and browsers need HTTPS for microphone access."
fi

# Install npm dependencies
echo
echo "Installing npm dependencies..."
npm install

# Check for Claude Code CLI (needed by the SDK)
if command -v claude &> /dev/null; then
    echo "✓ Claude Code CLI found"
else
    echo
    echo "NOTE: Claude Code CLI not found in PATH."
    echo "The SDK will try to find it, or you can install it:"
    echo "  npm install -g @anthropic-ai/claude-code"
fi

# Check API keys
echo
echo "=== Configuration ==="

if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "✓ ANTHROPIC_API_KEY is set"
else
    echo "NOTE: ANTHROPIC_API_KEY not set."
    echo "  If Claude Code is already authenticated on this machine, it will work."
    echo "  Otherwise, set: export ANTHROPIC_API_KEY=sk-ant-..."
fi

# Check for local Whisper server
WHISPER_URL="${WHISPER_URL:-http://127.0.0.1:9876/transcribe}"
if curl -s --connect-timeout 1 "$WHISPER_URL" > /dev/null 2>&1 || curl -s --connect-timeout 1 "${WHISPER_URL%/transcribe}" > /dev/null 2>&1; then
    echo "✓ Local Whisper server found at $WHISPER_URL"
else
    echo "NOTE: No local Whisper server at $WHISPER_URL"
    if [ -n "$OPENAI_API_KEY" ]; then
        echo "  Will use OpenAI Whisper API as fallback"
    else
        echo "  Set up faster-whisper for local transcription, or set OPENAI_API_KEY"
        echo "  See: https://github.com/SYSTRAN/faster-whisper"
    fi
fi

if [ -n "$OPENAI_API_KEY" ]; then
    echo "✓ OPENAI_API_KEY is set (fallback Whisper)"
else
    echo "NOTE: OPENAI_API_KEY not set (local Whisper only, or text input)"
fi

# Check for local TTS (Piper) server
TTS_URL="${TTS_URL:-http://127.0.0.1:9877/synthesize}"
if curl -s --connect-timeout 1 "${TTS_URL%/synthesize}" > /dev/null 2>&1; then
    echo "✓ Local TTS server found at $TTS_URL"
else
    echo "NOTE: No local TTS server at $TTS_URL"
    echo "  Replies will use the browser/phone's built-in voices instead."
    echo "  For nicer audio, run Piper behind a small HTTP wrapper:"
    echo "  https://github.com/rhasspy/piper"
fi

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo
    echo "Creating .env template..."
    cat > .env << 'EOF'
# Handsfree configuration
# Uncomment and set these if not already in your environment

# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...

# Optional: local Whisper server URL (default http://127.0.0.1:9876/transcribe)
# WHISPER_URL=http://127.0.0.1:9876/transcribe

# Optional: local TTS (Piper) server URL (default http://127.0.0.1:9877/synthesize)
# TTS_URL=http://127.0.0.1:9877/synthesize

# Optional: port (default 8443)
# PORT=8443
EOF
    echo "✓ Created .env file (edit to add your keys)"
fi

echo
echo "=== Setup Complete ==="
echo
echo "Start everything (web server + agent daemon, supervised):"
echo "  ./run.sh"
echo
echo "Each session picks its working directory in the app (default: your"
echo "home directory; pass a path to run.sh to change the default)."
echo
echo "Then open the printed https:// URL on your phone or browser."
echo
