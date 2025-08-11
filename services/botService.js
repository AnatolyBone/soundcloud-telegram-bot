// services/botService.js
import { setupTelegramHandlers } from '../src/botHandlers.js';

export default class BotService {
  constructor(bot) {
    this.bot = bot;
  }

  setupTelegramBot() {
    console.log('🔌 Настройка обработчиков Telegram...');
    setupTelegramHandlers(this.bot);
  }
}