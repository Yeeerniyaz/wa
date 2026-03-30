# Используем готовый образ, где Chrome уже вшит
FROM ghcr.io/puppeteer/puppeteer:21.5.0

# Переходим в root, чтобы создать папки и выдать права
USER root

WORKDIR /app

# Копируем зависимости
COPY package*.json ./

# Ставим только нужные пакеты
RUN npm install --omit=dev

# Копируем остальной код
COPY . .

# Ограничиваем память Node.js
CMD ["node", "--max-old-space-size=512", "index.js"]