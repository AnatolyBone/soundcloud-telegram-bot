const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const scdl = require('soundcloud-downloader').default;
const fs = require('fs');

const bot = new Telegraf('8119729959:AAETYnCygCDclelR_Y5P1O7xIP0cbHkQuVQ');
const app = express();

// Хранилище пользователей
const usersFile = './users.json';
let users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : {};

// Языки
const messages = {
  ru: {
    welcome: '👋 Привет! Отправь ссылку на трек из SoundCloud — я скачаю его 🎶',
    downloading: '🎵 Загружаю трек...',
    failed: '❌ Не удалось скачать трек.',
    stats: (count) => `📊 Ты скачал(а) ${count} трек(ов).`,
    chooseLang: '🌐 Выберите язык:',
    langSet: '✅ Язык установлен: русский 🇷🇺',
    menu: '📋 Меню',
  },
  en: {
    welcome: '👋 Hi! Send a SoundCloud track link — I’ll download it for you 🎶',
    downloading: '🎵 Downloading track...',
    failed: '❌ Failed to download track.',
    stats: (count) => `📊 You have downloaded ${count} track(s).`,
    chooseLang: '🌐 Choose language:',
    langSet: '✅ Language set to English 🇬🇧',
    menu: '📋 Menu',
  }
};

// Язык пользователя
const getLang = (id) => users[id]?.lang || 'ru';
const t = (id, key, ...args) => {
  const lang = getLang(id);
  const msg = messages[lang][key];
  return typeof msg === 'function' ? msg(...args) : msg;
};

// Сохранение
const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));

// Команда /start
bot.start((ctx) => {
  const id = ctx.from.id;
  if (!users[id]) {
    users[id] = { downloads: 0, lang: 'ru' };
    saveUsers();
  }

  const welcomeMessage = `👋 Привет! / Hello!\n\n` +
    `🇷🇺 Отправь ссылку на трек из SoundCloud — я скачаю его 🎶\n` +
    `🇬🇧 Send a SoundCloud track link — I’ll download it for you 🎶`;

  const lang = getLang(id);
  const menuLabel = messages[lang].menu;

  ctx.reply(welcomeMessage, Markup.keyboard([[menuLabel]]).resize());
});

// Обработка кнопки Меню
bot.hears(['📋 Меню', '📋 Menu'], (ctx) => {
  ctx.reply(t(ctx.from.id, 'chooseLang'), Markup.inlineKeyboard([
    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
    Markup.button.callback('🇬🇧 English', 'lang_en')
  ]));
});

// Смена языка
bot.action(/lang_(.+)/, (ctx) => {
  const lang = ctx.match[1];
  const id = ctx.from.id;
  users[id].lang = lang;
  saveUsers();

  const menuLabel = messages[lang].menu;

  ctx.editMessageText(t(id, 'langSet'));
  ctx.reply(messages[lang].welcome, Markup.keyboard([[menuLabel]]).resize());
});

// Статистика
bot.command('stats', (ctx) => {
  const id = ctx.from.id;
  const count = users[id]?.downloads || 0;
  ctx.reply(t(id, 'stats', count));
});

// Обработка SoundCloud-ссылок
bot.on('text', async (ctx) => {
  const url = ctx.message.text;
  const id = ctx.from.id;
  if (!url.includes('soundcloud.com')) return;

  try {
    await ctx.reply(t(id, 'downloading'));
    const info = await scdl.getInfo(url);
    const stream = await scdl.download(url);

    users[id] = users[id] || { downloads: 0, lang: 'ru' };
    users[id].downloads += 1;
    saveUsers();

    await ctx.replyWithAudio({ source: stream, filename: `${info.title}.mp3` });
  } catch (error) {
    console.error('Ошибка:', error.message);
    ctx.reply(t(id, 'failed'));
  }
});

// Webhook
bot.telegram.setWebhook('https://soundcloud-telegram-bot.onrender.com/telegram');
app.use(bot.webhookCallback('/telegram'));

app.get('/', (req, res) => res.send('✅ Бот работает!'));
app.listen(3000, () => console.log('🚀 Сервер запущен на порту 3000'));
