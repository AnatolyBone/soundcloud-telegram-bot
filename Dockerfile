# Используем многоступенчатую сборку для минимизации образа
# Стадия сборки
FROM node:20-alpine AS builder

# Устанавливаем системные зависимости (Alpine использует apk)
RUN apk add --no-cache \
    ffmpeg \
    curl \
    python3 \
    py3-pip \
    && pip3 install --no-cache-dir yt-dlp==2023.11.16

# Проверяем версии
RUN yt-dlp --version && ffmpeg -version

# Устанавливаем зависимости Node.js
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Финальная стадия
FROM node:20-alpine

# Копируем системные зависимости из стадии builder
COPY --from=builder /usr/bin/ffmpeg /usr/bin/ffmpeg
COPY --from=builder /usr/bin/yt-dlp /usr/bin/yt-dlp
COPY --from=builder /usr/lib/ /usr/lib/ # Для совместимости библиотек

# Создаем непривилегированного пользователя
RUN addgroup -S app && adduser -S app -G app
USER app

# Копируем установленные зависимости и исходный код
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Запускаем приложение
CMD ["node", "index.js"]
