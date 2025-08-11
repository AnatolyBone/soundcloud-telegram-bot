// src/botHandlers.js

import { Markup } from 'telegraf';
import { T } from '../config/texts.js';
import { getUser, updateUserField, setPremium, getAllUsers } from '../db.js';
import { enqueue, downloadQueue } from '../services/downloadManager.js';
import { formatMenuMessage, isSubscribed, extractUrl } from './utils.js';
import { ADMIN_ID, WEBHOOK_URL } from '../config.js';

const kb = () => Markup.keyboard([[T('menu'), T('upgrade')], [T('mytracks'), T('help')]]).resize();

export function setupTelegramHandlers(bot) {
    bot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId) return next();
        try {
            ctx.state.user = await getUser(userId, ctx.from.first_name, ctx.from.username);
        } catch (error) {
            console.error(`Ошибка в мидлваре для userId ${userId}:`, error);
        }
        return next();
    });

    const getBonusKeyboard = (user) => {
        const keyboard = [];
        if (!user.subscribed_bonus_used) {
            keyboard.push([{ text: '✅ Я подписался, получить бонус!', callback_data: 'check_subscription' }]);
        }
        return { inline_keyboard: keyboard };
    };

    bot.action('check_subscription', async (ctx) => {
        try {
            const user = ctx.state.user || await getUser(ctx.from.id);
            if (user.subscribed_bonus_used) {
                return await ctx.answerCbQuery('Вы уже получали этот бонус. Спасибо!', { show_alert: true });
            }
            const channel = '@SCM_BLOG';
            if (await isSubscribed(ctx.from.id, channel, bot)) {
                await setPremium(ctx.from.id, 30, 7);
                await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
                await ctx.editMessageText(
                    '🎉 *Поздравляем!*\n\nВаша подписка на канал подтверждена. Вам начислен бонус: *7 дней тарифа Plus*.\n\nЧтобы увидеть обновленный статус, нажмите /menu.',
                    { parse_mode: 'Markdown' }
                );
            } else {
                await ctx.answerCbQuery('Кажется, вы еще не подписаны на канал.', { show_alert: true });
                await ctx.reply(`Пожалуйста, сначала подпишитесь на ${channel}, а затем нажмите кнопку еще раз.`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '➡️ Перейти в канал', url: 'https://t.me/SCM_BLOG' }],
                            [{ text: '✅ Я подписался!', callback_data: 'check_subscription' }]
                        ]
                    }
                });
            }
        } catch (e) {
            console.error('Ошибка в обработчике check_subscription:', e);
            await ctx.answerCbQuery('Произошла ошибка, попробуйте позже.', { show_alert: true });
        }
    });

    bot.start(async (ctx) => {
        try {
            const user = ctx.state.user || await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
            const messageText = formatMenuMessage(user, ctx, T);
            await ctx.reply(messageText, { reply_markup: getBonusKeyboard(user) });
            await ctx.reply('Выберите действие:', kb());
        } catch (e) {
            console.error('Ошибка в /start:', e);
        }
    });

    bot.hears(T('menu'), async (ctx) => {
        try {
            const user = ctx.state.user || await getUser(ctx.from.id);
            const messageText = formatMenuMessage(user, ctx, T);
            await ctx.reply(messageText, { reply_markup: getBonusKeyboard(user) });
        } catch (e) {
            console.error('Ошибка в hears(menu):', e);
        }
    });

    bot.hears(T('upgrade'), async (ctx) => {
        try {
            await ctx.replyWithMarkdown(T('upgradeInfo'), { disable_web_page_preview: true });
        } catch (e) {
            console.error('Ошибка в hears(upgrade):', e);
        }
    });

    bot.hears(T('help'), (ctx) => ctx.reply(T('helpInfo'), kb()));
    bot.hears(T('mytracks'), (ctx) => ctx.reply("В разработке", kb()));

    bot.command('admin', async (ctx) => {
        if (ctx.from.id.toString() !== ADMIN_ID.toString()) return;
        try {
            const stats = await getDashboardStats(); // Предполагая, что есть такая функция
            const dashboardUrl = WEBHOOK_URL.replace(/\/$/, '');
            
            const message = `
📊 <b>Статистика Бота</b>
👤 Всего: <i>${stats.totalUsers}</i>
📥 Загрузок: <i>${stats.totalDownloads}</i>
⚙️ Очередь: <i>${downloadQueue.active} / ${downloadQueue.size}</i>
🔗 <a href="${dashboardUrl}/admin">Открыть админ-панель</a>`;
            
            await ctx.replyWithHTML(message.trim());
        } catch (e) {
            console.error('❌ Ошибка в команде /admin:', e);
        }
    });

    bot.on('text', async (ctx) => {
        try {
            const url = extractUrl(ctx.message.text);
            if (url) {
                await enqueue(ctx, ctx.from.id, url);
            } else {
                // Игнорируем текстовые команды, чтобы не было конфликтов
                const commandTexts = Object.values(allTextsSync());
                if (!commandTexts.includes(ctx.message.text)) {
                    await ctx.reply(T('start'));
                }
            }
        } catch (e) {
            console.error('Ошибка в on(text):', e);
        }
    });
}