FROM node:24.18.0-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
ARG VITE_STREAM_MARKDOWN_INTERVAL_MS=50
ENV VITE_STREAM_MARKDOWN_INTERVAL_MS=$VITE_STREAM_MARKDOWN_INTERVAL_MS
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24.18.0-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/src/server/schema.sql ./src/server/schema.sql
EXPOSE 3000
CMD ["npm", "start"]
