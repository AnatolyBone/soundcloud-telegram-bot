// src/bot.js
import { Telegraf, Markup } from 'telegraf';
import * as commands from './bot/commands.js';
import * as hears from './bot/hears.js';
import * as actions from './bot/actions.js';
import { WEBHOOK_PATH } from './config.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(commands.start);
bot.command('admin', commands.admin);

bot.hears('📋 Меню', hears.menu);
bot.hears('ℹ️ Помощь', hears.help);
bot.hears('🔓 Расширить лимит', hears.upgrade);
bot.hears('🎵 Мои треки', hears.myTracks);

bot.action('check_subscription', actions.checkSubscription);

bot.on('text', commands.text);

export { bot };