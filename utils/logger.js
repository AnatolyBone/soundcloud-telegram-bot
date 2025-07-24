const TASK_LOG_KEY = 'task:logs';
const MAX_LOGS = 100;

export async function logTask(message) {
  if (!global.redisClient) {
    console.error('Redis клиент не инициализирован!');
    return;
  }

  const timestamp = new Date().toISOString();
  const entry = `${timestamp} — ${message}`;

  await global.redisClient.lPush(TASK_LOG_KEY, entry);
  await global.redisClient.lTrim(TASK_LOG_KEY, 0, MAX_LOGS - 1);
}

export async function getTaskLogs() {
  if (!global.redisClient) {
    console.error('Redis клиент не инициализирован!');
    return [];
  }

  return await global.redisClient.lRange(TASK_LOG_KEY, 0, MAX_LOGS - 1);
}