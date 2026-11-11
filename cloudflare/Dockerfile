# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      printf 'Acquire::https::CaInfo "/run/secrets/proxy_ca";\n' > /etc/apt/apt.conf.d/99-build-ca; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      tesseract-ocr \
      tesseract-ocr-eng \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99-build-ca

WORKDIR /app
COPY --chown=node:node package.json receipt-ocr.js ./
COPY --chown=node:node cloudflare/ocr-server.js ./cloudflare/ocr-server.js

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    OMP_THREAD_LIMIT=1

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "cloudflare/ocr-server.js"]
