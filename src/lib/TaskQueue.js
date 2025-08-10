class TaskQueue {
  constructor({ maxConcurrent, taskProcessor }) {
    this.maxConcurrent = maxConcurrent;
    this.taskProcessor = taskProcessor;
    this.queue = [];
    this.running = 0;
  }

  add(task) {
    this.queue.push(task);
    this.processQueue();
  }

  async processQueue() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.running++;
    const task = this.queue.shift();

    try {
      await this.taskProcessor(task);
    } catch (error) {
      console.error("Task processing error:", error);
    } finally {
      this.running--;
      this.processQueue();
    }
  }
}

export { TaskQueue };