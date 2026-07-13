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

if [ -n "$OPENAI_API_KEY" ]; then
    echo "✓ OPENAI_API_KEY is set (Whisper transcription enabled)"
else
    echo "NOTE: OPENAI_API_KEY not set."
    echo "  Voice transcription uses OpenAI's Whisper API."
    echo "  Set: export OPENAI_API_KEY=sk-..."
    echo "  Or add to .env file: OPENAI_API_KEY=sk-..."
    echo "  Without this, you can still use the text input box."
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

# Optional: port (default 8443)
# PORT=8443
EOF
    echo "✓ Created .env file (edit to add your keys)"
fi

echo
echo "=== Setup Complete ==="
echo
echo "To start the server:"
echo "  node server.js /path/to/your/project"
echo
echo "Or use the run script:"
echo "  ./run.sh /path/to/your/project"
echo
