FROM node:20-alpine

# Добавляем часовые пояса
RUN apk add --no-cache tzdata
ENV TZ=Asia/Almaty

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "--max-old-space-size=256", "index.js"]