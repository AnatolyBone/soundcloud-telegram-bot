require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const scdl = require('soundcloud-downloader').default;
const fs = require('fs');
const path = require('path');

const token = process.env.BOT_TOKEN;
const clientId = 'vF3vRMFpTgZzqzDzsdgJ7zD4gmZTY4vK';
const baseUrl = process.env.BASE_URL; // Пример: https://your-app-name.onrender.com

if (!token || !baseUrl) {
  throw new Error('❌ BOT_TOKEN или BASE_URL не указан в переменных окружения!');
}

const bot = new TelegramBot(token, { webHook: { port: process.env.PORT || 3000 } });
const app = express();

const webhookUrl = `${baseUrl}/bot${token}`;
bot.setWebHook(webhookUrl);

// Обработка входящих сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();

  if (!url || !url.includes('soundcloud.com')) {
    return bot.sendMessage(chatId, '📎 Отправь ссылку на трек или плейлист SoundCloud');
  }

  bot.sendMessage(chatId, '⏬ Загружаю...');

  try {
    const info = await scdl.getInfo(url, clientId);
    if (info.tracks) {
      // Это плейлист
      for (const track of info.tracks) {
        const trackStream = await scdl.download(track.permalink_url, clientId);
        const fileName = `track_${Date.now()}.mp3`;
        const writeStream = fs.createWriteStream(fileName);
        trackStream.pipe(writeStream);

        await new Promise((resolve, reject) => {
          writeStream.on('finish', () => {
            bot.sendAudio(chatId, fileName, {
              title: track.title,
              performer: track.user?.username || 'SoundCloud',
            }).then(() => {
              fs.unlinkSync(fileName);
              resolve();
            }).catch(reject);
          });
          writeStream.on('error', reject);
        });
      }
    } else {
      // Это одиночный трек
      const fileName = `track_${Date.now()}.mp3`;
      const stream = await scdl.download(url, clientId);
      const writeStream = fs.createWriteStream(fileName);

      stream.pipe(writeStream);
      writeStream.on('finish', () => {
        bot.sendAudio(chatId, fileName, {
          title: info.title,
          performer: info.user?.username || 'SoundCloud',
        }).then(() => {
          fs.unlinkSync(fileName);
        });
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

app.use(express.json());
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
