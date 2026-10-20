FROM node:22-bookworm-slim AS base

ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

WORKDIR /app

COPY package*.json ./

FROM base AS dependencies

RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev

RUN rm -rf /app/.cache/puppeteer \
    && npx puppeteer browsers install

RUN node -e 'const fs = require("node:fs"); const p = require("puppeteer"); const executable = p.executablePath(); console.log("Puppeteer Chrome:", executable); if (!fs.existsSync(executable)) throw new Error("Puppeteer Chrome was not installed");'

FROM base AS final

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p data

COPY . .

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/.cache/puppeteer /app/.cache/puppeteer

RUN node -e 'const fs = require("node:fs"); const p = require("puppeteer"); const executable = p.executablePath(); console.log("Final image Chrome:", executable); if (!fs.existsSync(executable)) throw new Error("Puppeteer Chrome is missing from the final image");'

EXPOSE 8088

CMD ["node", "server.js"]
