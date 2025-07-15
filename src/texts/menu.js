import { getTariffName, getDaysLeft } from '../utils/tariff.js';
import { getReferralLink } from '../utils/user.js';

export function formatMenuMessage(user) {
  const tariffLabel = getTariffName(user.premium_limit);
  const downloadsToday = user.downloads_today || 0;
  const invited = user.invited_count || 0;
  const bonusDays = user.bonus_days || 0;
  const refLink = getReferralLink(user.id);
  const daysLeft = getDaysLeft(user.premium_until);

  return `
👋 Привет, ${user.first_name}!

📥 Бот качает треки и плейлисты с SoundCloud в MP3.  
Просто пришли ссылку — и всё 🧙‍♂️

📣 Хочешь быть в курсе новостей, фишек и бонусов?  
Подпишись на наш канал 👉 @SCM_BLOG

🔄 При отправке ссылки ты увидишь свою позицию в очереди.  
🎯 Платные тарифы идут с приоритетом — их треки загружаются первыми.  
📥 Бесплатные пользователи тоже получают треки — просто чуть позже.

💼 Тариф: ${tariffLabel}  
⏳ Осталось дней: ${daysLeft}

🎧 Сегодня скачано: ${downloadsToday} из ${user.premium_limit}

👫 Приглашено: ${invited}  
🎁 Получено дней Plus по рефералам: ${bonusDays}

🔗 Твоя реферальная ссылка:  
${refLink}
  `.trim();
}