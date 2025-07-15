import { getTariffName, getDaysLeft } from '../texts/tariff.js';

export function getReferralLink(userId) {
  return `https://t.me/SCloudMusicBot?start=${userId}`;
}

export function getPersonalMessage(user) {
  const tariffName = getTariffName(user.premium_limit);

  return `Привет, ${user.first_name}!

😎 Этот бот — не стартап и не команда разработчиков.  
Я делаю его сам, просто потому что хочется удобный и честный инструмент.  
Без рекламы, без сбора данных — всё по-простому.

Если пользуешься — круто. Рад, что зашло.  
Спасибо, что ты тут 🙌

💼 Текущий тариф: ${tariffName}

⚠️ Скоро немного снизим лимиты, чтобы бот продолжал работать стабильно.  
Проект держится на моих ресурсах, и иногда приходится идти на такие меры.

Надеюсь на понимание. 🙏`;
}