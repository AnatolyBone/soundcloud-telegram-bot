const { Telegraf } = require('telegraf');
const express = require('express');
const scdl = require('soundcloud-downloader');

const bot = new Telegraf('8119729959:AAETYnCygCDclelR_Y5P1O7xIP0cbHkQuVQ'); // токен в коде
const app = express();

// 🔧 Укажи адрес Render-приложения:
const WEBHOOK_URL = 'https://your-render-name.onrender.com'; // ← замени на свой

// Реакция на ссылку
bot.on('text', async (ctx) => {
  const url = ctx.message.text;
  if (!url.includes('soundcloud.com')) return;

  try {
    await ctx.reply('🎵 Загружаю трек...');

    const info = await scdl.getInfo(url);
    const stream = await scdl.download(url);

    await ctx.replyWithAudio({ source: stream, filename: `${info.title}.mp3` });
  } catch (err) {
    console.error('Ошибка:', err.message);
    ctx.reply('❌ Не удалось скачать трек.');
  }
});

// Настройка webhook
app.use(bot.webhookCallback('/telegram'));
bot.telegram.setWebhook(`${WEBHOOK_URL}/telegram`);

// Пустая страница
app.get('/', (req, res) => res.send('✅ Бот работает!'));
app.listen(3000, () => console.log('🚀 Сервер запущен на порту 3000'));
