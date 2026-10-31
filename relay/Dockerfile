# DevTool relay. Build from the REPO ROOT, because the relay imports ../protocol/ts:
#
#   docker build -f relay/Dockerfile -t devtool-relay .
#   docker run --rm -p 8787:8787 -v devtool-relay-data:/data devtool-relay
#
# No build step and no npm install: the relay has no runtime dependencies and Node 24
# runs the TypeScript sources directly (type stripping).
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    RELAY_DATA=/data \
    LOG_LEVEL=info

WORKDIR /app
COPY protocol/package.json protocol/package.json
COPY protocol/ts protocol/ts
COPY relay/package.json relay/package.json
COPY relay/src relay/src

RUN rm -f protocol/ts/*.test.ts protocol/ts/generate-vectors.ts \
 && mkdir -p /data \
 && chown node:node /data

USER node
WORKDIR /app/relay
VOLUME /data
EXPOSE 8787 3478/udp

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

# exec form: node is PID 1 and gets SIGTERM directly for a graceful shutdown.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
