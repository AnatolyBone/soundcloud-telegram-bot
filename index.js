const TelegramBot = require('node-telegram-bot-api');
const scdl = require('soundcloud-downloader').default;
const fs = require('fs');

// === 🔐 КОНФИГУРАЦИЯ ===
const token = process.env.TELEGRAM_TOKEN || '8119729959:AAETYnCygCDclelR_Y5P1O7xIP0cbHkQuVQ';
const clientId = 'vF3vRMFpTgZzqzDzsdgJ7zD4gmZTY4vK'; // публичный client_id

if (!token) {
  throw new Error('❌ Не указан Telegram Token!');
}

const bot = new TelegramBot(token, { polling: true });

// === 📥 ОБРАБОТКА СООБЩЕНИЙ ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();

  if (!url || !url.startsWith('http') || !url.includes('soundcloud.com')) {
    return bot.sendMessage(chatId, '📎 Отправь ссылку на трек или плейлист SoundCloud');
  }

  bot.sendMessage(chatId, '⏬ Загружаю трек...');

  try {
    const info = await scdl.getInfo(url, clientId);

    if (!info || !info.title) throw new Error('Информация о треке не получена');

    const fileName = `track_${Date.now()}.mp3`;
    const stream = await scdl.download(url, clientId);
    const writeStream = fs.createWriteStream(fileName);

    stream.pipe(writeStream);

    writeStream.on('finish', () => {
      bot.sendAudio(chatId, fileName, {
        title: info.title,
        performer: info.user?.username || 'SoundCloud',
      }).then(() => {
        fs.unlinkSync(fileName); // удаляем файл после отправки
      });
    });

    writeStream.on('error', (err) => {
      console.error('Ошибка при записи файла:', err);
      bot.sendMessage(chatId, '❌ Ошибка при сохранении файла.');
    });

  } catch (err) {
    console.error('Ошибка загрузки:', err.message || err);
    bot.sendMessage(chatId, '❌ Не удалось загрузить трек. Возможно, он защищён или ссылка неверна.');
  }
});
