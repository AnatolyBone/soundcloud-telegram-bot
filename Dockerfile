FROM node:20

# Установка зависимостей ОС (включая ffmpeg и pip)
RUN apt-get update && \
    apt-get install -y ffmpeg python3-pip && \
    pip install yt-dlp && \
    apt-get clean

# Установка зависимостей Node.js
WORKDIR /app
COPY package*.json ./
RUN npm install

# Копирование исходников
COPY . .

# Запуск сервера Express (порт 3000)
CMD ["node", "index.js"]
