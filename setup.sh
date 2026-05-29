#!/usr/bin/env bash
# marsClaw bootstrap installer.
#
# Detects OS, ensures nvm + Node (via nvm), installs Bun (via npm), installs
# deps, then hands off to the interactive setup CLI.

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Node version installed through nvm. Pinned to an EXACT version (not "--lts"
# and not "22") so a compromise of any single npm-registry-served Node minor
# can't slip in via a fresh install on a new machine. Bump deliberately when
# you've validated the new version; this file and .nvmrc must stay in sync.
NODE_VERSION="${NODE_VERSION:-22.18.0}"

# Bun version. Pinning bun matters more than pinning most deps: bun is the
# loader for everything that follows. Compromise of `bun` on npm = total
# compromise of the install. Bump deliberately after testing.
BUN_VERSION="${BUN_VERSION:-1.3.14}"

# Pinned nvm installer + SHA-256. Verifying the installer before piping to
# bash defends against an upstream raw-githubusercontent or repo compromise
# at the version we trust. To bump nvm: download the new installer, run
# `shasum -a 256 install.sh` locally, paste the new digest below.
NVM_VERSION="${NVM_VERSION:-v0.40.1}"
NVM_INSTALL_SHA256="${NVM_INSTALL_SHA256:-abdb525ee9f5b48b34d8ed9fc67c6013fb0f659712e401ecd88ab989b3af8f53}"

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

# Install nvm if missing. Download to a temp file, verify the SHA-256, then
# pipe-to-bash. A bare `curl … | bash` would execute whatever the registry
# served — version-pinned URL or not, raw-githubusercontent compromise would
# still ship attacker code. The hash gate catches that.
if ! command -v nvm >/dev/null 2>&1; then
  bold "Installing nvm ($NVM_VERSION)..."
  NVM_TMP="$(mktemp -t nvm-install.XXXXXX)"
  trap 'rm -f "$NVM_TMP"' EXIT
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" -o "$NVM_TMP"
  GOT_SHA="$(shasum -a 256 "$NVM_TMP" | awk '{print $1}')"
  if [ "$GOT_SHA" != "$NVM_INSTALL_SHA256" ]; then
    err "nvm installer SHA-256 mismatch — refusing to run."
    err "  expected: $NVM_INSTALL_SHA256"
    err "  got:      $GOT_SHA"
    err "Either nvm has shipped a new $NVM_VERSION (unusual) or the download is tampered."
    err "Bump NVM_VERSION + NVM_INSTALL_SHA256 in setup.sh after verifying upstream."
    exit 1
  fi
  bash "$NVM_TMP"
  rm -f "$NVM_TMP"
  trap - EXIT
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

# Install Bun (using the nvm-managed Node) if missing OR pinned-version-stale.
# Bun is the loader for everything else in this project — a compromise of bun
# on npm gives the attacker full execution before any of our gates can run.
# We pin to BUN_VERSION; if the current bun is older or newer, we reinstall.
need_bun=0
if ! command -v bun >/dev/null 2>&1; then
  need_bun=1
elif [ "$(bun --version 2>/dev/null)" != "$BUN_VERSION" ]; then
  warn "bun is $(bun --version 2>/dev/null), pin is $BUN_VERSION — reinstalling"
  need_bun=1
fi
if [ "$need_bun" = "1" ]; then
  bold "Installing Bun (pinned $BUN_VERSION)..."
  npm install -g "bun@$BUN_VERSION"
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

# Install JS deps. --frozen-lockfile refuses to mutate bun.lock — a fresh
# checkout must reproduce the exact dependency closure that's been audited.
# A divergence between package.json and bun.lock will fail loudly here
# (rather than silently pulling whatever's latest), which is the signal you
# want when investigating supply-chain risk.
bold "Installing JavaScript dependencies (frozen lockfile)..."
bun install --frozen-lockfile --silent

# Hand off to interactive TS setup
echo
exec bun run src/cli/index.ts setup
