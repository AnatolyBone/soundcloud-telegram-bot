import redisClient from '../index.js'; // путь зависит от структуры

const TASK_LOG_KEY = 'task:logs';
const MAX_LOGS = 100;

export async function logTask(message) {
  const timestamp = new Date().toISOString();
  const entry = `${timestamp} — ${message}`;
  await redisClient.lPush(TASK_LOG_KEY, entry);
  await redisClient.lTrim(TASK_LOG_KEY, 0, MAX_LOGS - 1); // сохраняем только последние 100 записей
}

export async function getTaskLogs() {
  return await redisClient.lRange(TASK_LOG_KEY, 0, MAX_LOGS - 1);
}