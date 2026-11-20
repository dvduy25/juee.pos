FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG API_ORIGIN
ENV NEXT_TELEMETRY_DISABLED=1
RUN test -n "$API_ORIGIN" && API_ORIGIN="$API_ORIGIN" npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ARG API_ORIGIN
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_ORIGIN=$API_ORIGIN
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build --chown=node:node /app/.next .next
COPY --from=build /app/next.config.mjs next.config.mjs
USER node
EXPOSE 3002
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0"]
