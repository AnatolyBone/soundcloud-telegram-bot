FROM node:20

# Установка ffmpeg и yt-dlp
RUN apt-get update && \
    apt-get install -y ffmpeg python3-pip && \
    pip3 install yt-dlp && \
    apt-get clean

# Установка зависимостей проекта
WORKDIR /app
COPY package*.json ./
RUN npm install

# Копирование исходников
COPY . .

# Запуск
CMD ["node", "index.js"]
