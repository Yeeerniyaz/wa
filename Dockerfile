FROM node:18-slim

# ХАК: Переписываем официальные зеркала Debian на быстрые зеркала Яндекса
RUN sed -i 's/deb.debian.org/mirror.yandex.ru/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's/deb.debian.org/mirror.yandex.ru/g' /etc/apt/sources.list

# Устанавливаем пакеты
RUN apt-get update -o Acquire::ForceIPv4=true && apt-get install -y -o Acquire::ForceIPv4=true \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "--max-old-space-size=512", "index.js"]