require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const bodyParser = require('body-parser');

const token = process.env.BOT_TOKEN;
const baseUrl = process.env.BASE_URL; // пример: https://your-service-name.onrender.com
const port = process.env.PORT || 3000;

if (!token) {
  throw new Error('❌ BOT_TOKEN не задан!');
}

let bot;

if (baseUrl) {
  // Используем webhook, если задан BASE_URL
  bot = new TelegramBot(token, { webHook: { port: port } });

  const app = express();
  app.use(bodyParser.json());

  // Устанавливаем webhook
  const webhookUrl = `${baseUrl}/bot${token}`;
  bot.setWebHook(webhookUrl);

  app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.listen(port, () => {
    console.log(`✅ Webhook сервер запущен на порту ${port}`);
    console.log(`🔗 Webhook URL: ${webhookUrl}`);
  });

} else {
  // Если BASE_URL не задан — fallback на polling
  bot = new TelegramBot(token, { polling: true });
  console.log('🚀 Бот запущен в режиме polling');
}

// Ответ на SoundCloud ссылки
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text || !text.includes('soundcloud.com')) {
    return bot.sendMessage(chatId, '📎 Пришли ссылку на трек или плейлист SoundCloud.');
  }

  try {
    bot.sendMessage(chatId, '⏬ Обрабатываю ссылку...');
    // TODO: тут вставь загрузку трека/плейлиста
  } catch (err) {
    console.error('Ошибка загрузки:', err.message);
    bot.sendMessage(chatId, '❌ Не удалось загрузить. Проверь ссылку и попробуй снова.');
  }
});
