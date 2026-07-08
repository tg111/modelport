FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8880
ENV PROXY_API_KEY=pwd
VOLUME ["/app/data"]
EXPOSE 8880

CMD ["node", "src/server.js"]
