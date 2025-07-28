// lib/TaskQueue.js
// Это простой, но эффективный менеджер очереди задач, который позволяет
// выполнять ограниченное количество задач одновременно.

export class TaskQueue {
    constructor(options = {}) {
        this.maxConcurrent = options.maxConcurrent || 1;
        this.taskProcessor = options.taskProcessor;

        if (typeof this.taskProcessor !== 'function') {
            throw new Error('Task processor function is required');
        }

        this.queue = [];
        this.active = 0;
    }

    /**
     * Добавляет новую задачу в очередь.
     * @param {object} task - Объект задачи для обработки.
     */
    add(task) {
        this.queue.push(task);
        this.processNext();
    }

    /**
     * Обрабатывает следующую задачу из очереди, если есть свободные слоты.
     */
    processNext() {
        if (this.active >= this.maxConcurrent || this.queue.length === 0) {
            return; // Все воркеры заняты или очередь пуста
        }

        const task = this.queue.shift(); // Берем следующую задачу
        this.active++;

        this.taskProcessor(task)
            .catch(err => {
                console.error('Unhandled error in task processor:', err);
            })
            .finally(() => {
                this.active--;
                this.processNext(); // Пытаемся запустить следующую задачу
            });
    }

    /**
     * Возвращает количество задач в очереди.
     */
    get size() {
        return this.queue.length;
    }

    /**
     * Возвращает количество активных (выполняющихся) задач.
     */
    get activeTasks() {
        return this.active;
    }
}