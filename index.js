require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const isSoundCloudUrl = (text) => {
  const regex = /(https?:\/\/)?(www\.)?(soundcloud\.com)\/[\w\-\/]+/i;
  return regex.test(text);
};

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || !isSoundCloudUrl(text)) return;

  const url = text.trim();
  bot.sendMessage(chatId, '⏬ Загружаю трек...');

  const outputTemplate = 'downloaded.%(ext)s';
  const cmd = `yt-dlp -x --audio-format mp3 -o "${outputTemplate}" "${url}"`;

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error('Ошибка загрузки:', error);
      bot.sendMessage(chatId, '⚠️ Произошла ошибка при загрузке трека.');
      return;
    }

    const lines = stdout.split('\n');
    let filename;

    for (const line of lines) {
      if (line.includes('Destination')) {
        filename = line.split('Destination')[1].trim();
        break;
      }
    }

    if (!filename) {
      // fallback: ищем файл вручную
      const files = fs.readdirSync('./').filter(f => f.startsWith('downloaded') && f.endsWith('.mp3'));
      filename = files[0];
    }

    if (filename && fs.existsSync(filename)) {
      bot.sendAudio(chatId, fs.createReadStream(filename)).then(() => {
        fs.unlinkSync(filename);
      }).catch(err => {
        console.error('Ошибка отправки аудио:', err);
        bot.sendMessage(chatId, '⚠️ Не удалось отправить файл.');
      });
    } else {
      bot.sendMessage(chatId, '⚠️ Файл не найден после загрузки.');
    }
  });
});
