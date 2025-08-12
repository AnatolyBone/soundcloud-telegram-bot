// services/botService.js
import { setupTelegramHandlers } from '../src/botHandlers.js';
import { downloadQueue } from './downloadManager.js';

export default class BotService {
  constructor(bot) {
    this.bot = bot;
  }

  setupTelegramBot() {
    console.log('🔌 Настройка обработчиков Telegram...');
    setupTelegramHandlers(this.bot);

    // Мониторинг очереди теперь здесь
    setInterval(() => {
        console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`);
    }, 60 * 1000);
  }
}