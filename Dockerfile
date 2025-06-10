FROM node:20

# Устанавливаем системные зависимости
RUN apt-get update && \
    apt-get install -y ffmpeg curl python3-pip && \
    pip3 install yt-dlp && \
    apt-get clean

# Проверим, что yt-dlp установлен
RUN yt-dlp --version

# Устанавливаем зависимости Node.js
WORKDIR /app
COPY package*.json ./
RUN npm install

# Копируем исходный код
COPY . .

# Запускаем бота
CMD ["node", "index.js"]

fix: add yt-dlp to Dockerfile

