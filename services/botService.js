// services/botService.js
import { setupTelegramHandlers } from '../src/botHandlers.js';
import { downloadQueue } from './downloadManager.js'; // <<< ДОБАВЛЯЕМ ИМПОРТ

export default class BotService {
  constructor(bot) {
    this.bot = bot;
  }

  setupTelegramBot() {
    console.log('🔌 Настройка обработчиков Telegram...');
    setupTelegramHandlers(this.bot);