import { getRedisClient } from '../index.js';

const TASK_LOG_KEY = 'task:logs';
const MAX_LOGS = 100;

export async function logTask(message) {
  const client = getRedisClient();
  if (!client) throw new Error('Redis client не инициализирован');
  
  const timestamp = new Date().toISOString();
  const entry = `${timestamp} — ${message}`;
  await client.lPush(TASK_LOG_KEY, entry);
  await client.lTrim(TASK_LOG_KEY, 0, MAX_LOGS - 1);
}

export async function getTaskLogs() {
  const client = getRedisClient();
  if (!client) throw new Error('Redis client не инициализирован');
  
  return await client.lRange(TASK_LOG_KEY, 0, MAX_LOGS - 1);
}