FROM node:20

# Установка ffmpeg и yt-dlp
RUN apt-get update && apt-get install -y ffmpeg python3-pip \
    && pip3 install yt-dlp

# Рабочая директория
WORKDIR /app

# Копирование зависимостей и установка
COPY package*.json ./
RUN npm install

# Копирование остального кода
COPY . .

# Запуск бота
CMD ["node", "index.js"]
