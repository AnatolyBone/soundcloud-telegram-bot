import { TaskQueue } from '../lib/TaskQueue.js';
import { logTask } from '../utils/logger.js'; // Адаптируй пути
import { processTrackByUrl } from ./index.js'; // Предполагаемый путь к обработчику
import { resolveRedirect } from './urlResolver.js';
import { getUser, logUserActivity, resetDailyLimitIfNeeded } from './user.js';
import { texts } from '../constants/texts.js';
import { Markup } from 'telegraf';

// --- 1. Определяем функцию, которая будет обрабатывать одну задачу ---

/**
 * Обрабатывает задачу загрузки трека. Эта функция будет передана в нашу очередь.
 * @param {object} task - Объект задачи { ctx, userId, url, playlistUrl, priority }
 */
async function trackDownloadProcessor(task) {
  const { ctx, userId, url, playlistUrl } = task;
  const startTime = Date.now();

  await logTask(`🚀 Старт: ${url} (userId: ${userId}, priority: ${task.priority})`);
  console.log(`[Queue: ${downloadQueue.active}/${downloadQueue.maxConcurrent}] 🚀 Старт: ${url}`);
  
  try {
    // Основная бизнес-логика
    await processTrackByUrl(ctx, userId, url, playlistUrl);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    await logTask(`✅ Успех: ${url} (за ${duration} сек)`);
    console.log(`[Queue: ${downloadQueue.active}/${downloadQueue.maxConcurrent}] ✅ Успех: ${url}`);

  } catch (err) {
    await logTask(`❌ Ошибка: ${url} — ${err.message}`);
    console.error(`❌ Ошибка обработки ${url}:`, err);
    
    // Попытка уведомить пользователя об ошибке
    try {
      await ctx.telegram.sendMessage(
        userId,
        `❌ Произошла ошибка при загрузке трека: ${url}\nПожалуйста, попробуйте еще раз позже.`
      );
    } catch (sendErr) {
      console.error(`⚠️ Не удалось отправить сообщение об ошибке пользователю ${userId}:`, sendErr);
    }

    // Важно "пробросить" ошибку дальше, чтобы внешний обработчик в TaskQueue ее залогировал
    throw err;
  }
}

// --- 2. Создаем и экспортируем единственный экземпляр нашей очереди ---

export const downloadQueue = new TaskQueue({
  maxConcurrent: 8, // Легко настраивается
  taskProcessor: trackDownloadProcessor,
});


// --- 3. Обновленная функция `enqueue` для добавления задач ---

let enqueueCounter = 0; // Можно оставить для отладки, если нужно

/**
 * Добавляет задачу в очередь загрузки с валидацией и лимитами.
 * @param {object} ctx - Telegram-контекст
 * @param {number} userId - ID пользователя
 * @param {string} url - Ссылка на трек или плейлист
 * @param {number} priority - Приоритет задачи (например, 10 для обычных, 100 для премиум)
 */
export async function enqueue(ctx, userId, url, priority = 10) {
  enqueueCounter++;
  const label = `enqueue:${userId}:${enqueueCounter}`;
  console.time(label);

  try {
    // Шаг 1: Валидация и подготовка
    const resolvedUrl = await resolveRedirect(url);
    await logUserActivity(userId);
    await resetDailyLimitIfNeeded(userId);
    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - user.downloads_today;

    // Шаг 2: Проверка лимитов
    if (remainingLimit <= 0) {
      await ctx.telegram.sendMessage(
        userId,
        texts.limitReached,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Я подписался', 'check_subscription')
        ])
      );
      return; // Важно завершить выполнение
    }

    // Шаг 3: Создание и добавление задачи в очередь (ИСПРАВЛЕННЫЙ БАГ)
    const task = {
      ctx,
      userId,
      url: resolvedUrl,
      priority,
      // Можно добавить и другие метаданные, если нужно
      // playlistUrl: ... 
    };

    downloadQueue.add(task);

    // Опционально: уведомить пользователя, что задача принята в обработку
    await ctx.reply(`Ваш трек добавлен в очередь на загрузку. Текущая позиция: ~${downloadQueue.size}`);

  } catch (err) {
    console.error(`❌ Ошибка в enqueue для ${url}:`, err);
    await ctx.reply('❌ Не удалось добавить трек в очередь. Возможно, ссылка недействительна.');
  } finally {
    console.timeEnd(label);
  }
}