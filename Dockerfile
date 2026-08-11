FROM node:24.18.0-alpine3.24

ENV NODE_ENV=production \
    PORT=8080 \
    APP_VERSION=1.0.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/gateway-health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
