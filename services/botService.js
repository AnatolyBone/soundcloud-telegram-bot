// services/botService.js
//
// This module defines a simple BotService class used by the application entry point.
// The purpose of the class is to encapsulate Telegram bot setup logic.  In the
// current project structure the implementation of the bot's handlers has been
// relocated to other modules (for example, indexer.js), so this class acts as
// a thin wrapper around those handlers.  Should you wish to add more complex
// behaviour, import the relevant functions here and register them on the bot.

export default class BotService {
  /**
   * Create a new BotService.
   * @param {import('telegraf').Telegraf} bot Telegraf bot instance
   */
  constructor(bot) {
    this.bot = bot;
  }

  /**
   * Register handlers on the bot instance.  The method is intentionally left
   * empty to avoid circular dependencies and duplicate imports.  To add
   * handlers, import your functions here and call the appropriate Telegraf
   * methods.  For example:
   *
   *   import { T } from '../config/texts.js';
   *   this.bot.start(async (ctx) => ctx.reply(T('start')));
   */
  setupTelegramBot() {
    // No-op by default.  Handlers should be registered elsewhere or added
    // explicitly if needed.
  }
}