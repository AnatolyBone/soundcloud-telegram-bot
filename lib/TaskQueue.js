import { logTask } from './utils/logger.js'; // Адаптируй путь

/**
 * Высокопроизводительная асинхронная очередь задач с приоритетами и ограничением параллелизма.
 * @class TaskQueue
 */
export class TaskQueue {
  /**
   * @param {object} options
   * @param {number} [options.maxConcurrent=8] - Максимальное количество одновременно выполняемых задач.
   * @param {function(object): Promise<void>} options.taskProcessor - Асинхронная функция для обработки одной задачи.
   */
  constructor({ maxConcurrent = 8, taskProcessor }) {
    if (typeof taskProcessor !== 'function') {
      throw new Error('taskProcessor должен быть функцией');
    }

    this.maxConcurrent = maxConcurrent;
    this.taskProcessor = taskProcessor;
    
    // ВАЖНО: Для высоконагруженных систем здесь должна быть настоящая
    // приоритетная очередь (на основе бинарной кучи), а не массив.
    // Сортировка массива на каждой вставке - это O(N*logN),
    // а вставка в бинарную кучу - O(logN).
    // Рекомендуемые библиотеки: 'tinyqueue', 'fastpriorityqueue'.
    this.queue = [];
    
    this.activeCount = 0;
    this.isPaused = false;
  }

  /**
   * Добавляет задачу в очередь.
   * @param {object} task - Объект задачи. Должен содержать числовое поле `priority`.
   */
  add(task) {
    if (this.isPaused) {
      console.warn('Очередь на паузе. Задача не добавлена.');
      return;
    }
    if (typeof task.priority !== 'number') {
      throw new Error('Задача должна содержать числовой приоритет (priority)');
    }
    
    // Временно оставляем сортировку, но помним о неэффективности.
    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority);

    // Сразу же пытаемся запустить обработку
    this._processNext();
  }

  /**
   * Внутренний метод для запуска обработки задач из очереди.
   * @private
   */
  _processNext() {
    // Запускаем новые задачи, пока есть свободные слоты и задачи в очереди.
    while (!this.isPaused && this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift(); // Берем задачу с наивысшим приоритетом
      this.activeCount++;

      // Запускаем обработку без `await`, чтобы не блокировать цикл
      (async () => {
        try {
          await this.taskProcessor(task);
        } catch (error) {
          // Логируем ошибку, но не даем ей остановить всю очередь.
          // Конкретная обработка ошибки (отправка сообщения пользователю) делегирована `taskProcessor`.
          console.error(`❌ Критическая ошибка в обработчике задачи: ${error.message}`, { task });
          await logTask(`CRITICAL: ${task.url} - ${error.message}`);
        } finally {
          this.activeCount--;
          // После завершения задачи (успешного или нет) освобождается слот,
          // поэтому мы снова проверяем, можно ли запустить что-то еще.
          this._processNext();
        }
      })();
    }
  }

  // --- Дополнительные управляющие методы ---

  /**
   * Приостанавливает обработку новых задач из очереди.
   */
  pause() {
    this.isPaused = true;
    console.log('▶️ Очередь поставлена на паузу.');
  }

  /**
   * Возобновляет обработку задач.
   */
  resume() {
    if (!this.isPaused) return;
    this.isPaused = false;
    console.log('✅ Очередь снята с паузы. Возобновление обработки...');
    this._processNext(); // Запускаем обработку, если есть задачи
  }

  /**
   * Возвращает текущий размер очереди.
   * @returns {number}
   */
  get size() {
    return this.queue.length;
  }

  /**
   * Возвращает количество активных задач.
   * @returns {number}
   */
  get active() {
    return this.activeCount;
  }
}