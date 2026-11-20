FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace=@juee/web --include-workspace-root
COPY frontend frontend
COPY website/build.mjs website/build.mjs
COPY website/src website/src
ARG API_ORIGIN
ARG CONTACT_FACEBOOK_URL
ARG CONTACT_INSTAGRAM_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN test -n "$API_ORIGIN" && API_ORIGIN="$API_ORIGIN" npm run build:web

FROM node:22-bookworm-slim
WORKDIR /app
ARG API_ORIGIN
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_ORIGIN=$API_ORIGIN
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace=@juee/web
COPY --from=build --chown=node:node /app/frontend/.next frontend/.next
COPY --from=build /app/frontend/public frontend/public
COPY --from=build /app/frontend/next.config.mjs frontend/next.config.mjs
WORKDIR /app/frontend
USER node
EXPOSE 3000
CMD ["node", "../node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
