FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node client.mjs ./

USER node

CMD ["node", "client.mjs"]