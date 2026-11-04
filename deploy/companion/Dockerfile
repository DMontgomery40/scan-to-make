# syntax=docker/dockerfile:1
# CI can export the exact filtered build context without npm/apt changing it.
FROM scratch AS context-audit
COPY . /

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64 || (echo 'Blender 5.0.1 publishes Linux x64 only' >&2; exit 1)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils python3 python3-venv \
    libegl1 libgl1 libxkbcommon0 libsm6 libxi6 libxrender1 libxxf86vm1 \
    libseccomp2 xvfb xauth tini \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/companion/download-blender.sh /tmp/download-blender.sh
RUN bash /tmp/download-blender.sh /opt/blender && rm /tmp/download-blender.sh
# Separate install trees: Bambu's required postinstall patches must not change
# the generic backend's copy of bambu-node. Preserve upstream install scripts.
RUN npm install --global --prefix /opt/printers/bambu bambu-printer-mcp@1.1.42 \
    && npm install --global --prefix /opt/printers/generic mcp-3d-printer-server@1.2.20 \
    && npm cache clean --force
WORKDIR /app
COPY packages/contracts packages/contracts
COPY packages/CounterpartKit/Sources/CounterpartKit/Resources/Starters packages/CounterpartKit/Sources/CounterpartKit/Resources/Starters
COPY services/project services/project
COPY services/printer-handoff services/printer-handoff
COPY services/companion services/companion
COPY tools/capture-mesh-convert tools/capture-mesh-convert
COPY tools/capture-pipeline tools/capture-pipeline
COPY tools/capture-fit-eval tools/capture-fit-eval
COPY tools/scan-repair tools/scan-repair
COPY tools/scan-correct tools/scan-correct
RUN for package in packages/contracts services/project services/printer-handoff services/companion; do npm ci --prefix "$package"; done \
    && npm run build --prefix services/companion \
    && for package in packages/contracts services/project services/printer-handoff services/companion; do npm prune --omit=dev --prefix "$package"; done \
    && npm cache clean --force
RUN python3 -m venv /opt/python \
    && /opt/python/bin/pip install --no-cache-dir \
       -r tools/capture-mesh-convert/requirements.txt -r tools/scan-correct/requirements.txt
ENV PATH="/opt/python/bin:/opt/blender:/opt/printers/bambu/bin:/opt/printers/generic/bin:${PATH}" \
    BLENDER=/opt/blender/blender LIBGL_ALWAYS_SOFTWARE=1 NODE_ENV=production HOME=/data/home
RUN mkdir -p /data/home && chown -R node:node /data
COPY deploy/companion deploy/companion
USER node
# No auth or printer configuration is baked in. Compose enables capture after init.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "/app/deploy/companion/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/deploy/companion/entrypoint.sh"]
CMD ["node", "/app/services/companion/dist/server-cli.js"]
