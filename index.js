require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const scdl = require('soundcloud-downloader').default;
const fs = require('fs');
const express = require('express');

const token = process.env.BOT_TOKEN;
const baseUrl = process.env.BASE_URL;
const clientId = 'vF3vRMFpTgZzqzDzsdgJ7zD4gmZTY4vK';

if (!token || !baseUrl) {
  throw new Error('❌ BOT_TOKEN или BASE_URL не указан в переменных окружения!');
}

const bot = new TelegramBot(token);
bot.setWebHook(`${baseUrl}/bot${token}`);

// Express-сервер
const app = express();
app.use(express.json());

app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

// Обработка сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();

  if (!url || !url.includes('soundcloud.com')) {
    return bot.sendMessage(chatId, '📎 Отправь ссылку на трек или плейлист SoundCloud');
  }

  bot.sendMessage(chatId, '⏬ Загружаю...');

  try {
    const info = await scdl.getInfo(url, clientId);

    if (info.kind === 'playlist') {
      for (const track of info.tracks) {
        try {
          const stream = await scdl.download(track.permalink_url, clientId);
          const fileName = `track_${Date.now()}.mp3`;
          const writeStream = fs.createWriteStream(fileName);
          stream.pipe(writeStream);

          await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
          });

          await bot.sendAudio(chatId, fileName, {
            title: track.title,
            performer: track.user.username || 'SoundCloud'
          });

          fs.unlinkSync(fileName);
        } catch (e) {
          console.error('❌ Ошибка с треком из плейлиста:', e.message);
        }
      }
    } else {
      const fileName = `track_${Date.now()}.mp3`;
      const stream = await scdl.download(url, clientId);
      const writeStream = fs.createWriteStream(fileName);

      stream.pipe(writeStream);

      writeStream.on('finish', async () => {
        await bot.sendAudio(chatId, fileName, {
          title: info.title,
          performer: info.user?.username || 'SoundCloud',
        });
        fs.unlinkSync(fileName);
      });

      writeStream.on('error', (err) => {
        console.error('Ошибка при записи файла:', err);
        bot.sendMessage(chatId, '❌ Ошибка при сохранении файла.');
      });
    }
  } catch (err) {
    console.error('Ошибка загрузки:', err.message || err);
    bot.sendMessage(chatId, '❌ Не удалось загрузить. Убедись, что ссылка корректна.');
  }
});
