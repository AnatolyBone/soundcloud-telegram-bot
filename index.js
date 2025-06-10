const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TOKEN = process.env.BOT_TOKEN;
const URL = process.env.RENDER_EXTERNAL_URL; // Render подставляет сам
const bot = new TelegramBot(TOKEN, { webHook: { port: 3000 } });

const app = express(); // Express нужен только для webhook endpoint, если хочешь

bot.setWebHook(`${URL}/bot${TOKEN}`);
console.log("✅ Бот работает через Webhook (порт 3000)");

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || !text.includes('soundcloud.com')) return;

  bot.sendMessage(chatId, "🎵 Загружаю трек...");

  exec(`yt-dlp -x --audio-format mp3 -o "downloaded.%(ext)s" "${text}"`, async (err, stdout, stderr) => {
    if (err) {
      console.error("Ошибка загрузки:", err);
      bot.sendMessage(chatId, "❌ Не удалось загрузить трек.");
      return;
    }

    const filePath = path.resolve('downloaded.mp3');
    const titleMatch = stdout.match(/title: (.+)/i);
    const title = titleMatch ? titleMatch[1] : 'SoundCloud Track';

    if (fs.existsSync(filePath)) {
      await bot.sendAudio(chatId, filePath, {
        title: title,
      });
      fs.unlinkSync(filePath); // удалим после отправки
    } else {
      bot.sendMessage(chatId, "❌ Файл не найден.");
    }
  });
});
