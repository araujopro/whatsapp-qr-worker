FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=8080
ENV SESSION_STORAGE_DIR=/data/baileys-auth

EXPOSE 8080

CMD ["npm", "start"]
