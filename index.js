require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Проверка, является ли сообщение ссылкой на SoundCloud
const isSoundCloudUrl = (text) => {
  const regex = /(https?:\/\/)?(www\.)?(soundcloud\.com)\/[\w\-\/]+/i;
  return regex.test(text);
};

// Реакция на любые входящие сообщения
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || !isSoundCloudUrl(text)) return;

  const url = text.trim();
  bot.sendMessage(chatId, '⏬ Загружаю трек, подожди немного...');

  const outputTemplate = 'downloaded.%(ext)s';
  const command = `yt-dlp -x --audio-format mp3 -o "${outputTemplate}" "${url}"`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error('Ошибка загрузки:', error);
      bot.sendMessage(chatId, '⚠️ Произошла ошибка при загрузке трека.');
      return;
    }

    let filename;

    // Парсим вывод, чтобы найти путь к файлу
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.includes('Destination')) {
        filename = line.split('Destination')[1].trim();
        break;
      }
    }

    // fallback: ищем вручную файл, если парсинг не помог
    if (!filename || !fs.existsSync(filename)) {
      const files = fs.readdirSync('./').filter(f => f.startsWith('downloaded') && f.endsWith('.mp3'));
      filename = files[0];
    }

    if (filename && fs.existsSync(filename)) {
      bot.sendAudio(chatId, fs.createReadStream(filename)).then(() => {
        fs.unlinkSync(filename); // удаляем файл после отправки
      }).catch(err => {
        console.error('Ошибка при отправке аудио:', err);
        bot.sendMessage(chatId, '⚠️ Не удалось отправить файл.');
      });
    } else {
      bot.sendMessage(chatId, '⚠️ Не удалось найти файл после загрузки.');
    }
  });
});
