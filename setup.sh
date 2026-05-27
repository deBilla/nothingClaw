#!/usr/bin/env bash
# marsClaw bootstrap installer.
#
# Detects OS, ensures nvm + Node (via nvm), installs Bun (via npm), installs
# deps, then hands off to the interactive setup CLI.

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Node version installed through nvm. Pinned to an LTS major (not "--lts", which
# drifts to whatever the newest LTS line is and could pull a brand-new major the
# agent CLI doesn't support yet). nvm install N grabs the latest N.x, so we still
# get patch/security updates within the line. Bump this to move the pin.
NODE_VERSION="${NODE_VERSION:-22}"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$1"; }
err()  { printf "\033[31merror:\033[0m %s\n" "$1" >&2; }

bold "marsClaw setup"
echo

OS="$(uname -s)"
case "$OS" in
  Darwin) ok "OS: macOS" ;;
  Linux)  ok "OS: Linux" ;;
  *) err "Unsupported OS: $OS. Use macOS, Linux, or WSL."; exit 1 ;;
esac

# nvm is a shell function, not a binary — it won't appear on PATH until its
# script is sourced into the current shell. Load it if already installed.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
load_nvm() { [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"; return 0; }
load_nvm

# Install nvm if missing
if ! command -v nvm >/dev/null 2>&1; then
  bold "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  load_nvm
  if ! command -v nvm >/dev/null 2>&1; then
    err "nvm install finished but \`nvm\` is not available. Reopen your shell and re-run setup.sh."
    exit 1
  fi
fi
ok "nvm: $(nvm --version)"

# Install + select the Node version via nvm
bold "Installing Node ($NODE_VERSION) via nvm..."
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"
ok "node: $(node --version)"
ok "npm: $(npm --version)"

# Install Bun via npm (using the nvm-managed Node) if missing
if ! command -v bun >/dev/null 2>&1; then
  bold "Installing Bun..."
  npm install -g bun
  if ! command -v bun >/dev/null 2>&1; then
    err "Bun install finished but \`bun\` is not on PATH. Reopen your shell and re-run setup.sh."
    exit 1
  fi
fi
ok "Bun: $(bun --version)"

# Seed local-only files from templates if missing
if [ ! -f MEMORY.md ] && [ -f MEMORY.template.md ]; then
  cp MEMORY.template.md MEMORY.md
  ok "Created MEMORY.md from template"
fi
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  ok "Created .env from template"
fi

# Install JS deps
bold "Installing JavaScript dependencies..."
bun install --silent

# Hand off to interactive TS setup
echo
exec bun run src/cli/index.ts setup
