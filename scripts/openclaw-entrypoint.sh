#!/usr/bin/env sh
# Entrypoint runs as root so we can:
#   - own the volume dir for the node user
#   - seed /data/openclaw.json from the baked default
#   - point /home/node/.openclaw/workspace at /data/workspace via symlink
#     (OpenClaw reads workspace canon from ~/.openclaw/workspace by default;
#     without this link the agent never sees USER.md/SOUL.md/AGENTS.md)
#   - seed workspace canon files (USER.md, AGENTS.md, SOUL.md) on every
#     boot so the model loads operator identity + soul on cold start
#   - substitute {env:VAR} placeholders with real env values
#   - fail fast if a required env var is missing
#   - normalize ownership for files chowned by privileged exec calls
# Then we drop to the unprivileged `node` user and exec the gateway.
set -eu

CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/data/openclaw.json}"
DEFAULT_PATH="/app/openclaw.default.json"
STATE_DIR="${OPENCLAW_STATE_DIR:-/data}"
WORKSPACE_DIR="${STATE_DIR}/workspace"
NODE_HOME="/home/node"
NODE_OPENCLAW_DIR="${NODE_HOME}/.openclaw"
NODE_WORKSPACE_LINK="${NODE_OPENCLAW_DIR}/workspace"

mkdir -p "$STATE_DIR" "$WORKSPACE_DIR" "$(dirname "$CONFIG_PATH")" "$NODE_OPENCLAW_DIR"

# Always overwrite /data/openclaw.json from the baked default at boot.
# Reason: the OpenClaw runtime persists config back to /data/openclaw.json
# in its own `{env:VAR}` placeholder syntax during normal operation, so
# a renamed env var (e.g. OPENCLAW_KEY → BITDEER_API_KEY) becomes a
# crashloop on the next deploy because the volume-stored copy still
# references the old var name. Single-tenant, single-operator stack —
# the baked default is the source of truth; the volume should never be
# the canonical config. The marker file is kept for diagnostics only.
BAKED_MARKER="${STATE_DIR}/.openclaw.default.applied"
echo "openclaw-entrypoint: writing $CONFIG_PATH from baked $DEFAULT_PATH (always)"
cp "$DEFAULT_PATH" "$CONFIG_PATH"
cp "$DEFAULT_PATH" "$BAKED_MARKER"

# Symlink the agent's expected workspace to the persistent volume.
# If a real directory already lives there (from a previous deploy that
# wrote files but didn't symlink), move its contents to the volume first.
if [ ! -L "$NODE_WORKSPACE_LINK" ]; then
  if [ -d "$NODE_WORKSPACE_LINK" ]; then
    echo "openclaw-entrypoint: migrating $NODE_WORKSPACE_LINK contents -> $WORKSPACE_DIR"
    # Copy files over (don't overwrite newer files on the volume).
    cp -an "$NODE_WORKSPACE_LINK/." "$WORKSPACE_DIR/" 2>/dev/null || true
    rm -rf "$NODE_WORKSPACE_LINK"
  elif [ -e "$NODE_WORKSPACE_LINK" ]; then
    rm -f "$NODE_WORKSPACE_LINK"
  fi
  ln -s "$WORKSPACE_DIR" "$NODE_WORKSPACE_LINK"
  echo "openclaw-entrypoint: linked $NODE_WORKSPACE_LINK -> $WORKSPACE_DIR"
fi

# Seed workspace canon files (operator identity, soul, agent rules) on
# every boot. The image-baked copy is the source of truth; we overwrite
# the volume copy ONLY when it differs from the baked default. Agent
# edits made to other files in /data/workspace are untouched.
for FILE in USER.md AGENTS.md SOUL.md DIRECTIVE.md TOOLS.md HEARTBEAT.md; do
  SRC="/app/$FILE"
  DEST="$WORKSPACE_DIR/$FILE"
  if [ -f "$SRC" ]; then
    if [ ! -f "$DEST" ] || ! cmp -s "$SRC" "$DEST"; then
      echo "openclaw-entrypoint: syncing $DEST from $SRC"
      cp "$SRC" "$DEST"
    fi
  fi
done

# Seed the task backlog ONCE. TASKS.md is mutable working state the
# agent edits as it claims and completes tasks — unlike the canon
# files above it must NEVER be force-synced, or a deploy would wipe
# task progress. Copy the baked template only when none exists yet.
if [ -f /app/TASKS.md ] && [ ! -f "$WORKSPACE_DIR/TASKS.md" ]; then
  echo "openclaw-entrypoint: seeding $WORKSPACE_DIR/TASKS.md (once)"
  cp /app/TASKS.md "$WORKSPACE_DIR/TASKS.md"
fi

# Seed GOVERNANCE.json once (mutable, operator-editable) and create an
# empty LEDGER.jsonl if absent (append-only outcome log). Like TASKS.md
# these are working state and must never be force-synced.
if [ -f /app/GOVERNANCE.json ] && [ ! -f "$WORKSPACE_DIR/GOVERNANCE.json" ]; then
  echo "openclaw-entrypoint: seeding $WORKSPACE_DIR/GOVERNANCE.json (once)"
  cp /app/GOVERNANCE.json "$WORKSPACE_DIR/GOVERNANCE.json"
fi
if [ ! -f "$WORKSPACE_DIR/LEDGER.jsonl" ]; then
  : > "$WORKSPACE_DIR/LEDGER.jsonl"
fi

# Substitute {env:VAR} placeholders with current env values. Fail fast
# if any placeholder references an env var that isn't set — better to
# crash the container than silently 401 every request.
python3 - "$CONFIG_PATH" <<'PYEOF'
import os, re, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    text = f.read()
missing = []
def repl(match):
    var = match.group(1)
    val = os.environ.get(var)
    if val is None or val == "":
        missing.append(var)
        return match.group(0)
    return val
new_text = re.sub(r"\{env:([A-Z_][A-Z0-9_]*)\}", repl, text)
if missing:
    print(
        "openclaw-entrypoint: FATAL — missing env vars referenced by "
        f"{path}: {sorted(set(missing))}",
        file=sys.stderr,
    )
    sys.exit(78)
if new_text != text:
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print(
        f"openclaw-entrypoint: substituted env placeholders in {path}",
        file=sys.stderr,
    )
PYEOF

# Substitute {env:VAR} placeholders in bob.js. /app is wiped on restart so
# the file always starts from the Docker-image template with bare placeholders.
BOB_JS_PATH="/app/dist/control-ui/assets/bob.js"
if [ -f "$BOB_JS_PATH" ]; then
  python3 - "$BOB_JS_PATH" <<'PYEOF'
import os, re, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    text = f.read()
missing = []
def repl(match):
    var = match.group(1)
    val = os.environ.get(var)
    if val is None or val == "":
        missing.append(var)
        return match.group(0)
    return val
new_text = re.sub(r"\{env:([A-Z_][A-Z0-9_]*)\}", repl, text)
if missing:
    print(
        "openclaw-entrypoint: FATAL — missing env vars for bob.js: "
        f"{sorted(set(missing))}",
        file=sys.stderr,
    )
    sys.exit(78)
if new_text != text:
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print(f"openclaw-entrypoint: substituted env vars in {path}", file=sys.stderr)
PYEOF
fi

# Always reset ownership of the state dir + node's openclaw dir so the
# gateway (running as node) can read+write. Privileged exec calls (root)
# leave files unreadable to node and the gateway crashloops with EACCES.
chown -R node:node "$STATE_DIR"
chown -h node:node "$NODE_WORKSPACE_LINK" 2>/dev/null || true
chown -R node:node "$NODE_OPENCLAW_DIR"
chmod 644 "$CONFIG_PATH"

# Ensure the Discord channel plugin is installed. @openclaw/discord is a
# downloadable official plugin, NOT bundled in the base image. The plugin
# installer needs the runtime context (mounted volume + seeded config),
# so a build-time install does not stick — it must run here, as the node
# user, before the gateway starts. Guarded so it only downloads once.
if [ "${OPENCLAW_DISCORD_PLUGIN:-1}" = "1" ]; then
  if runuser -u node -- sh -c 'cd /app && node dist/index.js plugins list 2>/dev/null' \
       | grep -qi 'discord'; then
    echo "openclaw-entrypoint: @openclaw/discord plugin already installed"
  else
    echo "openclaw-entrypoint: installing @openclaw/discord plugin..."
    runuser -u node -- sh -c 'cd /app && node dist/index.js plugins install @openclaw/discord --force' \
      || echo "openclaw-entrypoint: WARNING — @openclaw/discord install failed; Discord channel unavailable"
  fi
fi

# Launch the event poller daemon in the background, as the node user.
# It detects errors / cron failures / GitHub events and queues them as
# tasks for the agent. It is a separate process: if it dies the gateway
# is unaffected, and a launch failure here is non-fatal.
if [ "${OPENCLAW_POLLER:-1}" = "1" ] && [ -f /app/poll-events.mjs ]; then
  echo "openclaw-entrypoint: starting event poller daemon"
  runuser -u node -- sh -c 'cd /app && exec node poll-events.mjs >> /tmp/poll-events.log 2>&1' &
fi

# Launch the deep-worker daemon — a background reasoning subagent the
# main NOVA can dispatch hard tasks to via /data/jobs/pending/<id>.json.
# Lets long, expensive reasoning runs happen off the chat hot-path.
# Same non-fatal contract as the poller.
if [ "${OPENCLAW_DEEP_WORKER:-1}" = "1" ] && [ -f /app/deep-worker.mjs ]; then
  echo "openclaw-entrypoint: starting deep-worker daemon"
  runuser -u node -- sh -c 'cd /app && exec node deep-worker.mjs >> /tmp/deep-worker.log 2>&1' &
fi

# Drop to node and exec the gateway.
exec runuser -u node -- "$@"
