const express = require("express");
const bodyParser = require("body-parser");
const TelegramBot = require("node-telegram-bot-api");
const scdl = require("soundcloud-downloader").default;
require("dotenv").config();

const token = process.env.BOT_TOKEN;
const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
const baseUrl = process.env.BASE_URL;

if (!token || !clientId) {
  console.error("❌ BOT_TOKEN или SOUNDCLOUD_CLIENT_ID не заданы.");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: !baseUrl });
const port = process.env.PORT || 3000;

// Функция загрузки трека
async function downloadTrack(url) {
  try {
    const info = await scdl.getInfo(url, clientId);
    if (!info) return null;

    const stream = await scdl.download(url, clientId);
    return { title: info.title, stream };
  } catch (err) {
    console.error("Ошибка загрузки:", err.message);
    return null;
  }
}

// Обработка сообщений
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || !text.includes("soundcloud.com")) return;

  await bot.sendMessage(chatId, "⏬ Загружаю...");

  const track = await downloadTrack(text);

  if (!track) {
    await bot.sendMessage(chatId, "❌ Не удалось загрузить. Убедись, что ссылка корректна.");
    return;
  }

  await bot.sendAudio(chatId, track.stream, {
    title: track.title,
  });
});

// Webhook режим (если задан BASE_URL)
if (baseUrl) {
  bot.setWebHook(`${baseUrl}/bot${token}`);

  const app = express();
  app.use(bodyParser.json());

  app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.listen(port, () => {
    console.log(`✅ Webhook сервер запущен на порту ${port}`);
    console.log(`🔗 Webhook URL: ${baseUrl}/bot${token}`);
  });
}
