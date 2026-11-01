FROM node:24.13.0-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack pnpm install --frozen-lockfile --ignore-scripts
RUN corepack pnpm exec playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends xvfb xauth \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN corepack pnpm build
ENV NODE_ENV=production CONTAINER=1 PORT=4317 HEADLESS=false
EXPOSE 4317
CMD ["xvfb-run", "-a", "node", "dist/apps/service/src/main.js"]
