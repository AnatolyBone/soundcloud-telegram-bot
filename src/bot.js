// src/bot.js
import { Telegraf, Markup } from 'telegraf';
import * as commands from './bot/commands.js';
import * as hears from './bot/hears.js';
import * as actions from './bot/actions.js';
import { WEBHOOK_PATH } from './config.js';
import { getAllUsers, downloadQueue } from '../db.js'; // Подключаем функции для работы с пользователями и очередью
import { ADMIN_ID, WEBHOOK_URL } from '../config.js'; // Подключаем конфиги

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(commands.start);

// Добавляем команду /admin для админов
bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return; // Проверка, чтобы только админ мог выполнить эту команду

    try {
        // Получаем статистику по пользователям
        const users = await getAllUsers(true);
        const totalUsers = users.length;
        const activeUsers = users.filter(u => u.active).length;
        const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
        const now = new Date();
        const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === now.toDateString()).length;

        // Формируем URL для админки
        const dashboardUrl = `${WEBHOOK_URL.replace(/\/$/, '')}/dashboard`;

        // Формируем сообщение для админа
        const message = `
📊 <b>Статистика Бота</b>

👤 <b>Пользователи:</b>
   - Всего: <i>${totalUsers}</i>
   - Активных всего: <i>${activeUsers}</i>
   - Активных сегодня: <i>${activeToday}</i>

📥 <b>Загрузки:</b>
   - Всего за все время: <i>${totalDownloads}</i>

⚙️ <b>Очередь сейчас:</b>
   - В работе: <i>${downloadQueue.active}</i>
   - В ожидании: <i>${downloadQueue.size}</i>

🔗 <a href="${dashboardUrl}">Открыть админ-панель</a>`;
        
        // Отправляем статистику
        await ctx.replyWithHTML(message.trim());
    } catch (e) {
        console.error('❌ Ошибка в команде /admin:', e);
        try {
            await ctx.reply('⚠️ Произошла ошибка при получении статистики.');
        } catch {}
    }
});

bot.command('admin', commands.admin);

bot.hears('📋 Меню', hears.menu);
bot.hears('ℹ️ Помощь', hears.help);
bot.hears('🔓 Расширить лимит', hears.upgrade);
bot.hears('🎵 Мои треки', hears.myTracks);

bot.action('check_subscription', actions.checkSubscription);

bot.on('text', commands.text);

export { bot };