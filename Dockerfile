FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node index.js ./index.js
RUN mkdir -p /data && chown -R node:node /app /data

USER node
CMD ["node", "index.js"]
