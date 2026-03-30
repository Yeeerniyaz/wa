FROM node:18-slim

# Устанавливаем Chromium и шрифты для стабильной работы невидимого браузера
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Создаем рабочую директорию
WORKDIR /app

# Копируем файлы зависимостей
COPY package*.json ./

# Ставим пакеты (чистая установка)
RUN npm install

# Копируем весь исходный код
COPY . .

# Запускаем наш монолит
CMD ["node", "index.js"]