ARG NODE_VERSION=24.19.0
ARG ALPINE_VERSION=3.24

FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node-runtime

FROM alpine:${ALPINE_VERSION}

ARG APP_VERSION=1.0.0
ARG APP_IMAGE_TAG=1.0.0
ENV NODE_ENV=production \
    PORT=8080 \
    APP_VERSION=${APP_VERSION} \
    APP_IMAGE_TAG=${APP_IMAGE_TAG}

WORKDIR /app

RUN apk add --no-cache --upgrade libcrypto3 libssl3 libstdc++ \
    && addgroup -g 1000 -S node \
    && adduser -u 1000 -S -G node node

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/liveness').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
