// lib/TaskQueue.js

/**
 * Высокопроизводительная асинхронная очередь задач с приоритетами и ограничением параллелизма.
 * @class TaskQueue
 * 
 * ВАЖНО: Для production-систем с высокой нагрузкой рекомендуется заменить
 * стандартный массив и `.sort()` на настоящую структуру данных "Приоритетная очередь"
 * (на основе бинарной кучи), например, с помощью библиотеки 'tinyqueue'.
 * Это изменит сложность добавления с O(N*logN) до O(logN).
 */
export class TaskQueue {
  constructor({ maxConcurrent = 8, taskProcessor }) {
    if (typeof taskProcessor !== 'function') {
      throw new Error('taskProcessor должен быть функцией, которая возвращает Promise.');
    }
    this.maxConcurrent = maxConcurrent;
    this.taskProcessor = taskProcessor;
    this.queue = [];
    this.activeCount = 0;
  }

  add(task) {
    if (typeof task.priority !== 'number') {
      throw new Error('Задача должна содержать числовой приоритет (priority)');
    }
    this.queue.push(task);
    this.queue.sort((a, b) => a.priority - b.priority); // Сортируем по возрастанию, чтобы pop() брал самый высокий приоритет
    this._processNext();
  }

  _processNext() {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.pop(); // Берем задачу с наивысшим приоритетом
      this.activeCount++;
      (async () => {
        try {
          await this.taskProcessor(task);
        } catch (error) {
          console.error(`❌ Критическая ошибка в обработчике задачи: ${error.message}`, { url: task.url, userId: task.userId });
        } finally {
          this.activeCount--;
          this._processNext();
        }
      })();
    }
  }

  get size() {
    return this.queue.length;
  }

  get active() {
    return this.activeCount;
  }
}