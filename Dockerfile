FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8765
EXPOSE 8765

CMD ["node", "server.js"]
