// src/config.js
import 'dotenv/config'; // Для локального запуска

export const {
  BOT_TOKEN,
  ADMIN_ID,
  WEBHOOK_URL,
  WEBHOOK_PATH,
  PORT = 3000,
  SESSION_SECRET,
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  STORAGE_CHANNEL_ID,
  DATABASE_URL,
  SUPABASE_URL,
  SUPABASE_KEY,
  REDIS_URL
} = process.env;