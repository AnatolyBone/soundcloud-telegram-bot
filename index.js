require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const scdl = require('soundcloud-downloader').default;
const fs = require('fs');
const path = require('path');

const token = process.env.BOT_TOKEN;
const clientId = 'vF3vRMFpTgZzqzDzsdgJ7zD4gmZTY4vK';

if (!token) {
  throw new Error('❌ BOT_TOKEN не найден в переменных окружения!');
}

const bot = new TelegramBot(token, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();

  if (!url || !url.includes('soundcloud.com')) {
    return bot.sendMessage(chatId, '📎 Отправь ссылку на трек или плейлист SoundCloud');
  }

  bot.sendMessage(chatId, '🔍 Проверяю ссылку...');

  try {
    const info = await scdl.getInfo(url, clientId);

    // Если это плейлист
    if (info.kind === 'playlist') {
      const tracks = info.tracks;
      const total = tracks.length;
      bot.sendMessage(chatId, `🎧 Найден плейлист: ${info.title} — ${total} трек(ов).\nНачинаю загрузку...`);

      for (let i = 0; i < total; i++) {
        const track = tracks[i];
        const trackUrl = track.permalink_url;
        const stream = await scdl.download(trackUrl, clientId);
        const fileName = `track_${Date.now()}_${i}.mp3`;
        const writeStream = fs.createWriteStream(fileName);

        stream.pipe(writeStream);

        await new Promise((resolve, reject) => {
          writeStream.on('finish', async () => {
            await bot.sendAudio(chatId, fileName, {
              title: track.title,
              performer: track.user?.username || 'SoundCloud',
            });
            fs.unlinkSync(fileName);
            resolve();
          });

          writeStream.on('error', (err) => {
            console.error('Ошибка при записи трека:', err);
            bot.sendMessage(chatId, `❌ Ошибка при загрузке трека ${track.title}`);
            reject(err);
          });
        });
      }

      bot.sendMessage(chatId, '✅ Все треки из плейлиста отправлены!');

    } else {
      // Одиночный трек
      const stream = await scdl.download(url, clientId);
      const fileName = `track_${Date.now()}.mp3`;
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
    bot.sendMessage(chatId, '❌ Не удалось загрузить. Убедись, что ссылка корректна и не приватная.');
  }
});
