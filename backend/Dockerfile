FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --workspace=@juee/api --include-workspace-root
COPY backend/tsconfig.json backend/tsconfig.json
COPY backend/src backend/src
RUN npm run build:api

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=5000
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace=@juee/api
COPY --from=build /app/backend/dist backend/dist
USER node
EXPOSE 5000
CMD ["node", "backend/dist/main.js"]
