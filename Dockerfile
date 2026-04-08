FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV PORT=3000
ENV SESSION_STORAGE_DIR=/data/baileys-auth
EXPOSE 3000
CMD ["npm", "start"]
