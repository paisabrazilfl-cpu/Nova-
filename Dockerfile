# Minimal OPENCLAWOMEGA image: layer on the upstream OpenClaw image.
# The entrypoint runs as root to fix volume ownership before dropping to
# the unprivileged `node` user that the gateway runs as. Without this,
# any privileged exec (Fly's `flyctl ssh console` / Machines API exec)
# leaves files in /data owned by root, and the gateway crashloops on
# the next restart with EACCES on /data/openclaw.json.

FROM ghcr.io/openclaw/openclaw:latest

USER root

# Chromium for the `browser` tool. playwright-core does not ship a
# browser binary; without a system Chrome/Chromium the tool fails with
# "No supported browser found." Install Debian's chromium plus the
# minimum runtime libs Playwright actually loads in headless mode.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        libnss3 \
        libgbm1 \
        libasound2 \
        libxshmfence1 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libpangocairo-1.0-0 \
        curl \
        ca-certificates \
        jq \
        ripgrep \
        git \
        tree \
        unzip \
        less \
        nano \
        tesseract-ocr \
        poppler-utils \
        imagemagick \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Baked defaults; entrypoint seeds them onto the persistent volume.
COPY --chown=root:root openclaw.example.json /app/openclaw.default.json
COPY --chown=root:root USER.md /app/USER.md
COPY --chown=root:root SOUL.md /app/SOUL.md
COPY --chown=root:root AGENTS.md /app/AGENTS.md
COPY --chown=root:root DIRECTIVE.md /app/DIRECTIVE.md
COPY --chown=root:root TOOLS.md /app/TOOLS.md
COPY --chown=root:root HEARTBEAT.md /app/HEARTBEAT.md
COPY --chown=root:root TASKS.md /app/TASKS.md
COPY --chown=root:root GOVERNANCE.json /app/GOVERNANCE.json
COPY --chown=root:root scripts/poll-events.mjs /app/poll-events.mjs
COPY --chown=root:root scripts/ledger.mjs /app/ledger.mjs
COPY --chown=root:root scripts/deep-worker.mjs /app/deep-worker.mjs
COPY --chown=root:root tools/anti-hallucinate /app/anti-hallucinate
COPY --chown=root:root scripts/openclaw-entrypoint.sh /usr/local/bin/openclaw-entrypoint.sh
COPY --chown=root:root scripts/nova-cli.mjs /usr/local/bin/nova
RUN chmod +x /usr/local/bin/openclaw-entrypoint.sh /usr/local/bin/nova

# BOB chat UI bundle: served by the gateway under /assets/bob.js (same-origin,
# satisfies script-src 'self' CSP). Includes marked + highlight.js + UI logic.
COPY --chown=root:root assets/bob.js /app/dist/control-ui/assets/bob.js

# BOB chat UI: overwrite the upstream OpenClaw Control index so the gateway
# serves bob's UI at /. The page references /assets/bob.js (same-origin),
# which is copied above.
COPY --chown=root:root voice.html /app/dist/control-ui/index.html

# The Discord channel plugin (@openclaw/discord) is installed at runtime by
# the entrypoint — the plugin installer needs the mounted volume and seeded
# config, which do not exist at image-build time.

# Entrypoint stays root; the script drops to `node` via runuser before exec.
ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/openclaw-entrypoint.sh"]
