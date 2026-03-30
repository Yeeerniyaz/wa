# Минимальный образ — Chrome больше не нужен!
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Baileys работает в 256MB
CMD ["node", "--max-old-space-size=256", "index.js"]