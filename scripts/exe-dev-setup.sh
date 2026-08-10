#!/usr/bin/env bash
# exe-dev-setup.sh — provision a fresh exe.dev box with the forked prime-agent environment.
#
# Usage on a fresh box:
#   curl -fsSL https://raw.githubusercontent.com/nicklandshark/prime-agent/main/scripts/exe-dev-setup.sh | bash
#
# Or via exe.dev's first-boot hook (fits the 10KiB --setup-script cap as a one-liner):
#   ssh exe.dev new --name=mybox --setup-script="curl -fsSL https://raw.githubusercontent.com/nicklandshark/prime-agent/main/scripts/exe-dev-setup.sh | bash"
#
# What it does (idempotent — safe to re-run):
#   1. Installs Node 22.x (NodeSource) + build-essential, if node >=22.8 is absent.
#      NOTE: 22.x is load-bearing — the zeromq dep ships no Node-24 prebuild.
#   2. Ensures uv is installed (kernel venv bootstrap uses it).
#   3. Configures npm global prefix (~/.npm-global) + PATH in ~/.bashrc.
#   4. Installs the latest fork GitHub Release tarball of prime-agent
#      (public repo, no auth) with kernel/tools bootstrap enabled.
#   5. Installs the Steel CLI (skills depend on it; auth file still needed — see below).
#   6. If GH_TOKEN (or gh auth) is available: clones the PRIVATE companion repo
#      nicklandshark/prime-agent-env and applies config/skills/harness, and clones +
#      links the PRIVATE claude-better-oauth extension. Without auth these two steps
#      are skipped with a warning.
#
# Secrets are NOT handled here: auth.json and API-key env vars (WAFER_API_KEY,
# OPENROUTER_API_KEY, ...) must be delivered per-box out of band. The script ends
# with a checklist of anything still missing.

set -euo pipefail

FORK_REPO="nicklandshark/prime-agent"
ENV_REPO="nicklandshark/prime-agent-env"
EXT_REPO="nicklandshark/claude-better-oauth"
NODE_MAJOR="22"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }

# --- 1. Node -----------------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  # shellcheck disable=SC2046
  set -- $(node --version | tr -d 'v' | tr '.' ' ')
  if [ "$1" -gt "$NODE_MAJOR" ] || { [ "$1" -eq "$NODE_MAJOR" ] && [ "$2" -ge 8 ]; }; then
    need_node=0
    log "node $(node --version) already present"
    [ "$1" -eq "$NODE_MAJOR" ] || warn "node major != ${NODE_MAJOR} — only ${NODE_MAJOR}.x is tested (zeromq ships no Node-24 prebuild; a source build may fail)"
  else
    warn "node $(node --version) present but <22.8 — installing ${NODE_MAJOR}.x"
  fi
fi
if [ "$need_node" -eq 1 ]; then
  log "Installing Node ${NODE_MAJOR}.x via NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo apt-get install -y nodejs build-essential >/dev/null
fi
command -v node >/dev/null || { echo "node install failed" >&2; exit 1; }

# --- 2. uv -------------------------------------------------------------------
if ! command -v uv >/dev/null 2>&1; then
  log "Installing uv"
  curl -fsSL https://astral.sh/uv/install.sh | sh >/dev/null
  export PATH="$HOME/.local/bin:$PATH"
fi

# --- 3. npm prefix + PATH -----------------------------------------------------
npm config set prefix "$HOME/.npm-global"
for line in 'export PATH=$HOME/.npm-global/bin:$PATH' 'export PATH=$HOME/.steel/bin:$PATH'; do
  grep -qxF "$line" "$HOME/.bashrc" 2>/dev/null || echo "$line" >> "$HOME/.bashrc"
done
export PATH="$HOME/.npm-global/bin:$HOME/.steel/bin:$PATH"

# --- 4. prime-agent from latest fork release ----------------------------------
log "Resolving latest fork release"
api="https://api.github.com/repos/${FORK_REPO}/releases/latest"
tarball_url="$(curl -fsSL "$api" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for a in d["assets"]:
    n=a["name"]
    if (n.startswith("prime-agent-") and n.endswith(".tgz")
        and not any(n.startswith(p) for p in ("prime-agent-ai-","prime-agent-core-","prime-agent-tui-"))):
        print(a["browser_download_url"]); break
')"
[ -n "$tarball_url" ] || { echo "could not resolve latest release tarball" >&2; exit 1; }
log "Installing $tarball_url"
PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL=1 PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1 \
  npm install -g "$tarball_url"

# --- 5. Steel CLI --------------------------------------------------------------
if [ ! -x "$HOME/.steel/bin/steel" ]; then
  log "Installing Steel CLI"
  curl -fsS https://setup.steel.dev | sh -s -- --non-interactive >/dev/null
fi

# --- 6. Private repos (companion env + extension), only if auth available ------
have_auth=0
if [ -n "${GH_TOKEN:-}" ]; then
  have_auth=1
  git_auth_prefix="https://x-access-token:${GH_TOKEN}@github.com/"
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  have_auth=1
  git_auth_prefix="https://github.com/"
fi

if [ "$have_auth" -eq 1 ]; then
  log "Fetching companion env repo"
  tmp_env="$(mktemp -d)"
  git clone --quiet "${git_auth_prefix}${ENV_REPO}.git" "$tmp_env/env"
  mkdir -p "$HOME/.prime/agent" "$HOME/.agents" "$HOME/.claude" "$HOME/.codex"
  cp "$tmp_env/env/config/"* "$HOME/.prime/agent/"
  rsync -a "$tmp_env/env/skills/prime-agent/" "$HOME/.prime/agent/skills/"
  rsync -a "$tmp_env/env/skills/agents/"      "$HOME/.agents/skills/"
  rsync -a "$tmp_env/env/skills/claude/"      "$HOME/.claude/skills/"
  rsync -a "$tmp_env/env/skills/codex/"       "$HOME/.codex/skills/"
  rsync -a "$tmp_env/env/harness/"            "$HOME/.prime/agent/harness/"
  rm -rf "$tmp_env"

  log "Fetching claude-better-oauth extension"
  mkdir -p "$HOME/coding"
  if [ ! -d "$HOME/coding/claude-better-oauth" ]; then
    git clone --quiet "${git_auth_prefix}${EXT_REPO}.git" "$HOME/coding/claude-better-oauth"
  fi
  mkdir -p "$HOME/.prime/agent/extensions"
  ln -sfn "$HOME/coding/claude-better-oauth" "$HOME/.prime/agent/extensions/claude-better-oauth"
else
  warn "No GH_TOKEN / gh auth — skipped companion env repo (${ENV_REPO}) and extension (${EXT_REPO})."
  warn "Re-run with GH_TOKEN set, or apply manually per ${ENV_REPO} README."
fi

# --- Missing-secrets checklist --------------------------------------------------
log "Checking for secrets (delivered out of band)"
missing=0
[ -f "$HOME/.prime/agent/auth.json" ] || { warn "missing ~/.prime/agent/auth.json (scp from primary machine)"; missing=1; }
for v in WAFER_API_KEY OPENROUTER_API_KEY; do
  if ! grep -q "^export ${v}=" "$HOME/.bashrc" 2>/dev/null && [ -z "${!v:-}" ]; then
    warn "missing env var ${v} (add to ~/.bashrc)"
    missing=1
  fi
done
[ -f "$HOME/.config/steel/config.json" ] || warn "optional: ~/.config/steel/config.json (Steel auth) not present"

log "Done. prime-agent $(prime-agent --version </dev/null 2>/dev/null || echo 'NOT ON PATH — open a new shell')"
[ "$missing" -eq 0 ] && log "No required secrets missing." || true
