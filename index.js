require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const scdl = require('soundcloud-downloader'); // ✅ Правильный импорт
const fs = require('fs');

const token = process.env.BOT_TOKEN;
const clientId = 'vF3vRMFpTgZzqzDzsdgJ7zD4gmZTY4vK';

if (!token) {
  throw new Error('❌ TELEGRAM_TOKEN не найден в переменных окружения!');
}

const bot = new TelegramBot(token, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();

  if (!url || !url.includes('soundcloud.com')) {
    return bot.sendMessage(chatId, '📎 Отправь ссылку на трек или плейлист SoundCloud');
  }

  bot.sendMessage(chatId, '⏬ Загружаю...');

  try {
    const info = await scdl.getInfo(url, clientId);
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
      console.error('❌ Ошибка при записи файла:', err);
      bot.sendMessage(chatId, '❌ Ошибка при сохранении файла.');
    });

  } catch (err) {
    console.error('❌ Ошибка загрузки:', err.message || err);
    bot.sendMessage(chatId, '❌ Не удалось загрузить. Убедись, что ссылка корректна.');
  }
});
