# Используем готовый образ с Chromium и Node.js
FROM ghcr.io/puppeteer/puppeteer:21.5.0

# Переключаемся на root для настройки прав
USER root

# Создаем рабочую директорию
WORKDIR /app

# Копируем конфиги зависимостей
COPY package*.json ./

# Устанавливаем только нужные пакеты (без разработки)
RUN npm install --omit=dev

# Копируем код
COPY . .

# Ограничиваем память для Node.js
CMD ["node", "--max-old-space-size=512", "index.js"]