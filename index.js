require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const scdl = require('soundcloud-downloader').default;
const fs = require('fs');

const token = process.env.BOT_TOKEN;
const clientId = 'vF3vRMFpTgZzqzDzsdgJ7zD4gmZTY4vK';

if (!token) {
  throw new Error('❌ BOT_TOKEN не найден в переменных окружения!');
}

console.log('🚀 Бот запущен');

const bot = new TelegramBot(token, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();

  if (!url || !url.includes('soundcloud.com')) {
    return bot.sendMessage(chatId, '📎 Пришли ссылку на трек или плейлист SoundCloud');
  }

  bot.sendMessage(chatId, '🔍 Обрабатываю ссылку...');

  try {
    const info = await scdl.getInfo(url, clientId);

    // Если это плейлист
    if (info.kind === 'playlist' && info.tracks && info.tracks.length > 0) {
      bot.sendMessage(chatId, `📃 Найден плейлист: ${info.title}\nТреков: ${info.tracks.length}`);

      for (const track of info.tracks) {
        try {
          const trackUrl = track.permalink_url;
          const stream = await scdl.download(trackUrl, clientId);
          const fileName = `track_${Date.now()}.mp3`;
          const writeStream = fs.createWriteStream(fileName);
          stream.pipe(writeStream);

          await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
          });

          await bot.sendAudio(chatId, fileName, {
            title: track.title,
            performer: track.user?.username || 'SoundCloud',
          });

          fs.unlinkSync(fileName);
        } catch (trackErr) {
          console.error(`❌ Ошибка при загрузке трека из плейлиста: ${trackErr.message}`);
          bot.sendMessage(chatId, `❌ Ошибка при загрузке трека: ${track.title}`);
        }
      }

    } else {
      // Если это одиночный трек
      const stream = await scdl.download(url, clientId);
      const fileName = `track_${Date.now()}.mp3`;
      const writeStream = fs.createWriteStream(fileName);
      stream.pipe(writeStream);

      await new Promise((resolve, reject) => {
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
    console.error('❌ Ошибка при обработке ссылки:', err.message || err);
    bot.sendMessage(chatId, '❌ Не удалось загрузить. Убедись, что ссылка корректна.');
  }
});
