const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

const users = {}; // для хранения выбранного языка по userId

const messages = {
  ru: {
    start: 'Привет! Отправь ссылку на трек SoundCloud, и я пришлю тебе файл 🎵',
    menu: 'Меню',
    chooseLang: '🌐 Выберите язык:',
    loading: '🎵 Загружаю трек...',
    error: '❌ Не удалось скачать трек.',
  },
  en: {
    start: 'Hi! Send me a SoundCloud track link and I will send you the file 🎵',
    menu: 'Menu',
    chooseLang: '🌐 Choose your language:',
    loading: '🎵 Downloading track...',
    error: '❌ Failed to download track.',
  }
};

// Функция для получения языка пользователя, по умолчанию - ru
function getUserLang(id) {
  return users[id]?.lang || 'ru';
}

// Обработка команды /start
bot.start((ctx) => {
  const id = ctx.from.id;
  users[id] = users[id] || { lang: 'ru' };
  const lang = getUserLang(id);
  ctx.reply(messages[lang].start, Markup.keyboard([[messages[lang].menu]]).resize());
});

// Обработка нажатия на кнопку "Меню"
bot.hears(/^(Меню|Menu)$/i, (ctx) => {
  const id = ctx.from.id;
  const lang = getUserLang(id);
  ctx.reply(
    messages[lang].chooseLang,
    Markup.inlineKeyboard([
      Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
      Markup.button.callback('🇺🇸 English', 'lang_en'),
    ])
  );
});

// Обработка выбора языка
bot.action(/lang_(.+)/, (ctx) => {
  const id = ctx.from.id;
  const chosenLang = ctx.match[1];
  users[id] = users[id] || {};
  users[id].lang = chosenLang;
  ctx.answerCbQuery(`Language set to ${chosenLang === 'ru' ? 'Русский' : 'English'}`);
  ctx.editMessageText(
    chosenLang === 'ru' ? 'Язык установлен на русский 🇷🇺' : 'Language set to English 🇺🇸',
    Markup.keyboard([[messages[chosenLang].menu]]).resize()
  );
});

// Обработка сообщений с ссылками SoundCloud
bot.on('text', async (ctx) => {
  const id = ctx.from.id;
  const lang = getUserLang(id);
  const url = ctx.message.text;

  if (!url.includes('soundcloud.com')) return;

  ctx.reply(messages[lang].loading);

  // Формируем уникальное имя файла
  const outputFile = path.resolve(__dirname, `track_${id}_${Date.now()}.mp3`);

  try {
    // Скачиваем аудио через yt-dlp
    await youtubedl(url, {
      output: outputFile,
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      noPlaylist: true,
      quiet: true,
    });

    // Отправляем файл пользователю
    await ctx.replyWithAudio({ source: fs.createReadStream(outputFile) });

    // Удаляем файл после отправки
    fs.unlink(outputFile, (err) => {
      if (err) console.error('Ошибка при удалении файла:', err);
    });

  } catch (e) {
    console.error('Ошибка скачивания:', e);
    ctx.reply(messages[lang].error);
  }
});

// Webhook и express
bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/telegram`);

app.use(bot.webhookCallback('/telegram'));
app.get('/', (req, res) => res.send('✅ Бот работает!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));