import { Telegraf } from 'telegraf';
import { config } from '../config/env.js';

export const bot = new Telegraf(config.BOT_TOKEN);

// Заглушка
bot.command('start', (ctx) => ctx.reply('Привет, бот работает!'));

// Webhook экспорт (или launch() для разработки)
export function setupBotWebhook(app) {
  app.use(bot.webhookCallback('/bot'));
  bot.telegram.setWebhook(`${config.BASE_URL}/bot`);
}