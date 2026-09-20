FROM node:22-alpine AS base

WORKDIR /app

COPY package*.json ./

FROM base AS dependencies

RUN npm install --omit=dev

FROM base AS final

RUN mkdir -p data

RUN mkdir -p /userdir

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

EXPOSE 8088

CMD [ "node", "server.js" ]
