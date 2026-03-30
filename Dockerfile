# Используем легкий образ
FROM node:20-alpine

# Устанавливаем git (нужен для установки Baileys) и tzdata (для времени)
RUN apk add --no-cache git tzdata
ENV TZ=Asia/Almaty

WORKDIR /app

# Копируем только файлы зависимостей
COPY package*.json ./

# Теперь установка пройдет успешно
RUN npm install --omit=dev

# Копируем остальной код
COPY . .

# Запуск с ограничением памяти
CMD ["node", "--max-old-space-size=256", "index.js"]