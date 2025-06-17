// index.js
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');
const {
  createUser, getUser, updateUserField, incrementDownloads,
  setPremium, getAllUsers, addReview, saveTrackForUser, resetDailyStats
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';

const app = express();
const bot = new Telegraf(BOT_TOKEN);
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// Персональные очереди
const queues = {};

// Интервалы: кеш и ежедневный сброс
setInterval(cleanCache, 3600 * 1000);
setInterval(async () => {
  try { await resetDailyStats(); console.log('✅ Daily reset'); }
  catch (e) { console.error('❌ Daily reset failed', e); }
}, 24 * 3600 * 1000);

function cleanCache() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(cacheDir)) {
    const fp = path.join(cacheDir, f);
    if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
  }
}

// Тексты
const texts = { /* ... твой объект texts как выше ... */ };

// Клавиатура
const kb = lang => Markup.keyboard([
  [texts[lang].menu, texts[lang].upgrade],
  [texts[lang].mytracks, texts[lang].help],
  ['✍️ Оставить отзыв']
]).resize();

// Язык по умолчанию
const getLang = u => u?.lang || 'ru';

// /start
bot.start(async ctx => {
  await createUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].start, kb(getLang(u)));
});

// Смена языка
bot.hears([texts.ru.menu, texts.en.menu], async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].chooseLang, Markup.inlineKeyboard([
    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
    Markup.button.callback('🇬🇧 English', 'lang_en')
  ]));
});
bot.action(/lang_(\w+)/, async ctx => {
  const lang = ctx.match[1];
  await updateUserField(ctx.from.id, 'lang', lang);
  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, kb(lang));
});

// Помощь и апгрейд
bot.hears([texts.ru.upgrade, texts.en.upgrade], async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].upgradeInfo);
});
bot.hears([texts.ru.help, texts.en.help], async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].helpInfo);
});

// Отзывы
const reviewMode = new Set();
bot.hears('✍️ Оставить отзыв', async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].reviewAsk);
  reviewMode.add(ctx.from.id);
});

// Мои треки
bot.hears([texts.ru.mytracks, texts.en.mytracks], async ctx => {
  const u = await getUser(ctx.from.id);
  const list = (u.tracks_today || '').split(',').filter(Boolean);
  if (!list.length) return ctx.reply(texts[getLang(u)].noTracks);
  const media = list.map(name => {
    const fp = path.join(cacheDir, `${name}.mp3`);
    return fs.existsSync(fp)
      ? { type: 'audio', media: { source: fp } }
      : null;
  }).filter(Boolean);
  for (let i = 0; i < media.length; i += 10) {
    await ctx.replyWithMediaGroup(media.slice(i, i + 10));
  }
});

// Админ-панель и справка
bot.command('admin', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const users = await getAllUsers();
  const files = fs.readdirSync(cacheDir);
  const totalSize = files.reduce((s,f)=> s+fs.statSync(path.join(cacheDir,f)).size,0);
  const totalDownloads = users.reduce((s,u)=>s+u.total_downloads,0);
  const stats = {
    free: users.filter(u=>u.premium_limit===10).length,
    plus: users.filter(u=>u.premium_limit===50).length,
    pro: users.filter(u=>u.premium_limit===100).length,
    unlimited: users.filter(u=>u.premium_limit>=1000).length
  };
  const u = await getUser(ctx.from.id), lang = getLang(u);
  const text =
    `📊 Пользователей: ${users.length}\n` +
    `📥 Загрузок: ${totalDownloads}\n` +
    `📁 Кеш: ${files.length} файлы, ${(totalSize/1024/1024).toFixed(1)} MB\n\n` +
    `🆓 Free: ${stats.free}\n` +
    `🎯 Plus: ${stats.plus}\n` +
    `💪 Pro: ${stats.pro}\n` +
    `💎 Unlimited: ${stats.unlimited}\n\n` +
    texts[lang].adminCommands;
  ctx.reply(text);
});

bot.command('testdb', async ctx => {
  const u = await getUser(ctx.from.id);
  if (!u) return ctx.reply('Пользователь не найден');
  ctx.reply(`ID: ${u.id}\nСегодня: ${u.downloads_today}/${u.premium_limit}`);
});

bot.command('backup', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const src = path.join(__dirname,'database.sqlite');
    const dst = path.join(__dirname,`backup_${Date.now()}.sqlite`);
    fs.copyFileSync(src,dst);
    ctx.reply('✅ Бэкап готов');
  } catch(e){
    console.error(e);
    ctx.reply('❌ Ошибка при бэкапе');
  }
});

// Универсальный хендлер: сначала пропускаем команды
bot.on('text', async ctx => {
  const txt = ctx.message.text.trim();
  if (txt.startsWith('/')) return;  // ! проброс команд

  // Отзыв
  if (reviewMode.has(ctx.from.id)) {
    reviewMode.delete(ctx.from.id);
    await addReview(ctx.from.id, txt);
    await setPremium(ctx.from.id, 50, 30);
    const u = await getUser(ctx.from.id);
    return ctx.reply(texts[getLang(u)].reviewThanks, kb(getLang(u)));
  }

  // SoundCloud ссылка
  if (!txt.includes('soundcloud.com')) return;
  const user = await getUser(ctx.from.id), lang = getLang(user);
  if (user.downloads_today >= user.premium_limit)
    return ctx.reply(texts[lang].limitReached);

  // Добавляем в очередь
  if (!queues[ctx.from.id]) queues[ctx.from.id] = [];
  const pos = queues[ctx.from.id].length + 1;
  await ctx.reply(texts[lang].queuePosition(pos));
  queues[ctx.from.id].push(() => processTrack(ctx, txt));
  if (queues[ctx.from.id].length === 1) processNext(ctx.from.id);
});

async function processNext(id) {
  if (!queues[id]||!queues[id].length) return;
  const job = queues[id][0];
  await job();
  queues[id].shift();
  if (queues[id].length) processNext(id);
}

async function processTrack(ctx, url) {
  const user = await getUser(ctx.from.id), lang = getLang(user);
  try {
    await ctx.reply(texts[lang].downloading);
    const info = await ytdl(url,{dumpSingleJson:true});
    const name = (info.title||'track').replace(/[^\w\d]/g,'_').slice(0,50);
    const fp = path.join(cacheDir,`${name}.mp3`);
    if (!fs.existsSync(fp)) {
      await ytdl(url,{extractAudio:true,audioFormat:'mp3',output:fp});
    }
    await incrementDownloads(ctx.from.id,name);
    await saveTrackForUser(ctx.from.id,name);
    await ctx.replyWithAudio({source:fs.createReadStream(fp),filename:`${name}.mp3`});
  } catch(e) {
    console.error('❌ Download error:',e);
    ctx.reply(texts[lang].error);
  }
}

// Webhook
app.use(bot.webhookCallback('/telegram'));
app.get('/',(_,res)=>res.send('✅ OK'));
bot.telegram.setWebhook(WEBHOOK_URL)
  .then(()=>console.log('✅ Webhook установлен'))
  .catch(e=>console.error('❌ Webhook error',e));
app.listen(process.env.PORT||3000,()=>console.log('🚀 Server running'));