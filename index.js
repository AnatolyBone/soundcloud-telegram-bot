require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
const URL = process.env.RENDER_EXTERNAL_URL || `https://your-custom-url.onrender.com`; // Render будет сам подставлять

const bot = new TelegramBot(TOKEN, { webHook: { port: 3000 } });
bot.setWebHook(`${URL}/bot${TOKEN}`);

const app = express();
app.use(express.json());

// Telegram будет посылать POST-запросы сюда
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// SoundCloud URL check
const isSoundCloudUrl = (text) => {
  const regex = /(https?:\/\/)?(www\.)?(soundcloud\.com)\/[\w\-\/]+/i;
  return regex.test(text);
};

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || !isSoundCloudUrl(text)) return;

  const url = text.trim();
  bot.sendMessage(chatId, '⏬ Загружаю трек, подожди немного...');

  const outputTemplate = 'downloaded.%(title)s.%(ext)s';
  const command = `yt-dlp -x --audio-format mp3 -o "${outputTemplate}" "${url}"`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error('Ошибка загрузки:', error);
      bot.sendMessage(chatId, '⚠️ Не удалось загрузить трек.');
      return;
    }

    let filename;

    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.includes('Destination')) {
        filename = line.split('Destination')[1].trim();
        break;
      }
    }

    // fallback
    if (!filename || !fs.existsSync(filename)) {
      const files = fs.readdirSync('./').filter(f => f.endsWith('.mp3'));
      filename = files[0];
    }

    if (filename && fs.existsSync(filename)) {
      const fileTitle = path.basename(filename, path.extname(filename));

      bot.sendAudio(chatId, fs.createReadStream(filename), {
        title: fileTitle
      }).then(() => {
        fs.unlinkSync(filename);
      }).catch(err => {
        console.error('Ошибка при отправке файла:', err);
        bot.sendMessage(chatId, '⚠️ Не удалось отправить файл.');
      });
    } else {
      bot.sendMessage(chatId, '⚠️ Файл не найден.');
    }
  });
});

// Запускаем сервер Express
app.listen(3000, () => {
  console.log('✅ Бот работает через Webhook (порт 3000)');
});
