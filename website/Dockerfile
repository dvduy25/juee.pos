FROM node:22-bookworm-slim AS build
WORKDIR /site
COPY build.mjs ./
COPY src src
ARG APP_ORIGIN
ARG CONTACT_FACEBOOK_URL
ARG CONTACT_INSTAGRAM_URL
RUN test -n "$APP_ORIGIN" && APP_ORIGIN="$APP_ORIGIN" node build.mjs

FROM nginx:1.28-alpine
COPY --from=build /site/dist /usr/share/nginx/html
