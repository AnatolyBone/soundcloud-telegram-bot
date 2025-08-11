// bot.js

import { Telegraf } from 'telegraf';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('❌ Отсутствует переменная окружения BOT_TOKEN!');
    process.exit(1);
}

// Создаем и сразу экспортируем единственный экземпляр бота.
// Все остальные модули будут импортировать его отсюда.
export const bot = new Telegraf(BOT_TOKEN);