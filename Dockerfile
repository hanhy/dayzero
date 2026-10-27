FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/workflows/package.json packages/workflows/package.json
RUN npm ci
COPY scripts/clustering/requirements.txt /tmp/clustering-requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir --require-hashes -r /tmp/clustering-requirements.txt
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PYTHON_BIN=/opt/venv/bin/python
EXPOSE 3188
CMD ["npm", "start"]
