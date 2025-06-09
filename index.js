const TelegramBot = require('node-telegram-bot-api');
const scdl = require('soundcloud-downloader').default;
require('dotenv').config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text || !text.startsWith('http')) return;

  try {
    bot.sendChatAction(chatId, 'upload_audio');

    if (text.includes('/sets/')) {
      const playlist = await scdl.getSetInfo(text);
      for (const track of playlist.tracks.slice(0, 5)) {
        const stream = await scdl.download(track.permalink_url);
        await bot.sendAudio(chatId, stream, { title: track.title });
      }
    } else {
      const info = await scdl.getInfo(text);
      const stream = await scdl.download(text);
      await bot.sendAudio(chatId, stream, { title: info.title });
    }
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'Ошибка при загрузке трека. Убедись, что ссылка на SoundCloud корректна.');
  }
});
