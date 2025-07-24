/**
 * Высокопроизводительная асинхронная очередь задач с приоритетами и ограничением параллелизма.
 * @class TaskQueue
 * 
 * @description
 * Этот класс управляет выполнением асинхронных задач, гарантируя, что не более
 * `maxConcurrent` задач выполняются одновременно. Задачи добавляются с приоритетом,
 * и задачи с более высоким приоритетом выполняются первыми.
 * 
 * ВАЖНО: Для production-систем с высокой нагрузкой рекомендуется заменить
 * стандартный массив и `.sort()` на настоящую структуру данных "Приоритетная очередь"
 * (на основе бинарной кучи), например, с помощью библиотеки 'tinyqueue' или 'fastpriorityqueue'.
 * Это изменит сложность добавления с O(N*logN) до O(logN), что критично для больших очередей.
 */
export class TaskQueue {
  /**
   * @param {object} options
   * @param {number} [options.maxConcurrent=8] - Максимальное количество одновременно выполняемых задач.
   * @param {function(object): Promise<any>} options.taskProcessor - Асинхронная функция для обработки одной задачи.
   */
  constructor({ maxConcurrent = 8, taskProcessor }) {
    if (typeof taskProcessor !== 'function') {
      throw new Error('taskProcessor должен быть функцией, которая возвращает Promise.');
    }

    this.maxConcurrent = maxConcurrent;
    this.taskProcessor = taskProcessor;
    this.queue = [];
    this.activeCount = 0;
  }

  /**
   * Добавляет задачу в очередь.
   * @param {object} task - Объект задачи. Должен содержать числовое поле `priority`.
   */
  add(task) {
    if (typeof task.priority !== 'number') {
      throw new Error('Задача должна содержать числовой приоритет (priority)');
    }
    
    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority); // Сортируем, чтобы задачи с высоким приоритетом были в конце

    // Сразу же пытаемся запустить обработку
    this._processNext();
  }

  /**
   * Внутренний метод для запуска обработки задач из очереди.
   * @private
   */
  _processNext() {
    // Запускаем новые задачи, пока есть свободные слоты и задачи в очереди.
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      // Берем задачу с наивысшим приоритетом (из конца массива после сортировки)
      const task = this.queue.pop(); 
      this.activeCount++;

      // Запускаем обработку без `await`, чтобы не блокировать цикл
      (async () => {
        try {
          await this.taskProcessor(task);
        } catch (error) {
          // Логируем ошибку, но не даем ей остановить всю очередь.
          // Конкретная обработка ошибки (отправка сообщения пользователю) делегирована `taskProcessor`.
          console.error(`❌ Критическая ошибка в обработчике задачи: ${error.message}`, { url: task.url, userId: task.userId });
        } finally {
          this.activeCount--;
          // После завершения задачи освобождается слот,
          // поэтому мы снова проверяем, можно ли запустить что-то еще.
          this._processNext();
        }
      })();
    }
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