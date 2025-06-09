require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const scdl = require('soundcloud-downloader').default;
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const token = process.env.BOT_TOKEN;
const clientId = 'vF3vRMFpTgZzqzDzsdgJ7zD4gmZTY4vK';

if (!token) {
  throw new Error('❌ BOT_TOKEN не найден в переменных окружения!');
}

const bot = new TelegramBot(token, { polling: true });

// 📎 Обработка треков и плейлистов
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();

  if (!url || !url.includes('soundcloud.com')) {
    return bot.sendMessage(chatId, '📎 Пришли ссылку на трек или плейлист SoundCloud');
  }

  bot.sendMessage(chatId, '⏬ Загружаю...');

  try {
    const info = await scdl.getInfo(url, clientId);

    // Если это плейлист
    if (info.kind === 'playlist' && info.tracks) {
      for (let track of info.tracks.slice(0, 3)) { // Ограничим до 3 треков для теста
        const stream = await scdl.download(track.permalink_url, clientId);
        const fileName = `track_${Date.now()}.mp3`;
        const writeStream = fs.createWriteStream(fileName);

        await new Promise((resolve, reject) => {
          stream.pipe(writeStream);
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
        });

        await bot.sendAudio(chatId, fileName, {
          title: track.title,
          performer: track.user?.username || 'SoundCloud',
        });

        fs.unlinkSync(fileName);
      }
    } else {
      // Обычный трек
      const stream = await scdl.download(url, clientId);
      const fileName = `track_${Date.now()}.mp3`;
      const writeStream = fs.createWriteStream(fileName);

      await new Promise((resolve, reject) => {
        stream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      await bot.sendAudio(chatId, fileName, {
        title: info.title,
        performer: info.user?.username || 'SoundCloud',
      });

      fs.unlinkSync(fileName);
    }
  } catch (err) {
    console.error('Ошибка загрузки:', err.message || err);
    bot.sendMessage(chatId, '❌ Не удалось загрузить. Убедись, что ссылка корректна.');
  }
});

// 🟢 Express-сервер для Render
app.get('/', (req, res) => {
  res.send('Bot is running!');
});
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
