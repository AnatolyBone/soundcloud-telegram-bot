const { Telegraf } = require('telegraf');
const express = require('express');
const scdl = require('soundcloud-downloader').default;

const bot = new Telegraf('8119729959:AAETYnCygCDclelR_Y5P1O7xIP0cbHkQuVQ');
const app = express();

// Реакция на ссылки SoundCloud
bot.on('text', async (ctx) => {
  const url = ctx.message.text;
  if (!url.includes('soundcloud.com')) return;

  try {
    await ctx.reply('🎵 Загружаю трек...');
    const info = await scdl.getInfo(url);
    const stream = await scdl.download(url);

    await ctx.replyWithAudio({ source: stream, filename: `${info.title}.mp3` });
  } catch (error) {
    console.error('Ошибка:', error.message);
    ctx.reply('❌ Не удалось скачать трек.');
  }
});

// Webhook — тут уже твой Render URL
bot.telegram.setWebhook('https://soundcloud-telegram-bot.onrender.com/telegram');

// Подключение express
app.use(bot.webhookCallback('/telegram'));
app.get('/', (req, res) => res.send('✅ Бот работает!'));
app.listen(3000, () => console.log('🚀 Сервер запущен на порту 3000'));
