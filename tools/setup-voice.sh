#!/usr/bin/env bash
# Install voice support: Python venv with faster-whisper + a tiny FastAPI server.
# Idempotent — safe to re-run.

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VENV_DIR="tools/voice-env"
WHISPER_MODEL="${WHISPER_MODEL:-base}"   # tiny | base | small | medium | large(.en variants too)

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "\033[33m!\033[0m %s\n" "$1"; }
err()  { printf "\033[31m✗\033[0m %s\n" "$1" >&2; }

bold "marsClaw voice — Whisper installer"
echo

OS="$(uname -s)"
SUDO=""
if [ "$OS" = "Linux" ] && [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# Python — faster-whisper + kokoro-onnx (onnxruntime) only ship wheels for
# 3.11 and 3.12. 3.13+ and ≤3.10 fail to install, so we require an exact match.
py_ver() { "$1" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null; }
is_supported() { case "$1" in 3.11|3.12) return 0 ;; *) return 1 ;; esac; }

# Sets PYTHON_BIN / PY_VER to the first supported interpreter on PATH, else fails.
detect_python() {
  PYTHON_BIN=""; PY_VER=""
  for cand in python3.12 python3.11 python3; do
    command -v "$cand" >/dev/null 2>&1 || continue
    local v; v="$(py_ver "$cand")"
    if is_supported "$v"; then PYTHON_BIN="$cand"; PY_VER="$v"; return 0; fi
  done
  return 1
}

# Auto-installs Python 3.12 for the current OS (macOS via Homebrew, Debian/Ubuntu
# via apt, falling back to the deadsnakes PPA when the distro lacks 3.11/3.12).
install_python() {
  case "$OS" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        err "Homebrew not found — can't auto-install. Install brew (https://brew.sh) then re-run."
        return 1
      fi
      bold "Installing Python 3.12 via Homebrew…"
      brew install python@3.12 || return 1
      # python@3.12 is keg-only; expose its python3.12 on PATH for this run.
      local pfx; pfx="$(brew --prefix python@3.12 2>/dev/null)"
      [ -n "$pfx" ] && export PATH="$pfx/bin:$pfx/libexec/bin:$PATH"
      export PATH="$(brew --prefix)/bin:$PATH"
      ;;
    Linux)
      if ! command -v apt-get >/dev/null 2>&1; then
        err "No apt-get found. Install Python 3.11/3.12 with your package manager, then re-run."
        return 1
      fi
      bold "Installing Python 3.12 via apt…"
      $SUDO apt-get update -y || true
      if $SUDO apt-get install -y python3.12 python3.12-venv; then
        return 0
      elif $SUDO apt-get install -y python3.11 python3.11-venv; then
        return 0
      fi
      warn "Distro repos lack python3.11/3.12 — adding the deadsnakes PPA…"
      $SUDO apt-get install -y software-properties-common || true
      $SUDO add-apt-repository -y ppa:deadsnakes/ppa || return 1
      $SUDO apt-get update -y || true
      $SUDO apt-get install -y python3.12 python3.12-venv || return 1
      ;;
    *)
      err "Auto-install unsupported on $OS. Install Python 3.11/3.12 manually, then re-run."
      return 1
      ;;
  esac
}

if ! detect_python; then
  found="$(command -v python3 >/dev/null 2>&1 && py_ver python3 || echo none)"
  warn "No supported Python (3.11/3.12) found (default python3: ${found}). Installing automatically…"
  if ! install_python; then
    err "Automatic Python install failed. Install 3.11 or 3.12 manually, then re-run."
    exit 1
  fi
  if ! detect_python; then
    err "Python installed but 3.11/3.12 isn't on PATH yet. Open a new shell and re-run:  bun run voice install"
    exit 1
  fi
fi
ok "python: $PYTHON_BIN ($PY_VER)"

# ffmpeg (needed by faster-whisper to decode opus/ogg from WhatsApp)
if ! command -v ffmpeg >/dev/null 2>&1; then
  warn "ffmpeg not found — installing automatically…"
  case "$OS" in
    Darwin)
      command -v brew >/dev/null 2>&1 && brew install ffmpeg \
        || { err "Homebrew missing — install ffmpeg manually (brew install ffmpeg)."; exit 1; }
      ;;
    Linux)
      command -v apt-get >/dev/null 2>&1 && $SUDO apt-get install -y ffmpeg \
        || { err "Install ffmpeg manually (apt install ffmpeg)."; exit 1; }
      ;;
    *)
      err "Install ffmpeg manually, then re-run."; exit 1
      ;;
  esac
fi
ok "ffmpeg: $(ffmpeg -version | head -1 | awk '{print $3}')"

# venv
if [ -d "$VENV_DIR" ]; then
  EXISTING_VER="$(py_ver "$VENV_DIR/bin/python")"
  if ! is_supported "$EXISTING_VER"; then
    err "Existing venv at $VENV_DIR uses Python ${EXISTING_VER:-unknown}, which is unsupported."
    err "Delete it and re-run:  rm -rf $VENV_DIR && bun run voice install"
    exit 1
  fi
else
  bold "Creating Python venv at $VENV_DIR (using $PYTHON_BIN)"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
ok "venv: $VENV_DIR"

# pip install
bold "Installing Python deps (faster-whisper, kokoro-onnx, fastapi, uvicorn)…"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet faster-whisper kokoro-onnx soundfile fastapi 'uvicorn[standard]' python-multipart
ok "pip deps installed"

# Download Kokoro model (~325MB) + voices file
KOKORO_DIR="$VENV_DIR/kokoro"
mkdir -p "$KOKORO_DIR"
if [ ! -f "$KOKORO_DIR/kokoro-v1.0.onnx" ]; then
  bold "Downloading Kokoro model (kokoro-v1.0.onnx, ~325MB)…"
  curl -L --fail --progress-bar -o "$KOKORO_DIR/kokoro-v1.0.onnx" \
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
fi
if [ ! -f "$KOKORO_DIR/voices-v1.0.bin" ]; then
  bold "Downloading Kokoro voices (voices-v1.0.bin)…"
  curl -L --fail --progress-bar -o "$KOKORO_DIR/voices-v1.0.bin" \
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
fi
ok "Kokoro model files at $KOKORO_DIR"

# Pre-download the model so the first request isn't 30s of model fetch.
bold "Pre-downloading Whisper model: $WHISPER_MODEL"
"$VENV_DIR/bin/python" - <<PY
from faster_whisper import WhisperModel
WhisperModel("$WHISPER_MODEL", device="cpu", compute_type="int8")
print("[setup-voice] model '$WHISPER_MODEL' loaded and cached")
PY
ok "model cached"

echo
bold "Done."
echo "  Start both servers:   bun run voice start"
echo "  Check status:         bun run voice status"
echo "  Tail Whisper logs:    tail -f data/voice-whisper.log"
echo "  Tail Kokoro logs:     tail -f data/voice-kokoro.log"
echo
echo "Voice support is OFF in marsclaw until you set MARSCLAW_VOICE=1 in .env."
