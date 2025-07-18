const tariffs = `
🆓 Free — 5 треков в день  
🎯 Plus — 20 треков (59₽)  
💪 Pro — 50 треков (119₽)  
💎 Unlimited — безлимит (199₽)  
`;

const paymentInfo = `
👉 Донат: boosty.to/anatoly_bone/donate  
✉️ После оплаты напиши: @anatolybone  
`;

const bonusInfo = `
🎁 Бонус: 7 дней тарифа Plus за подписку — @bazaproject  
📣 Новости и подарки — @SCM_BLOG
`;

const promoInfo = `🎁 Акция: 1+1 — оплачиваешь тариф, получаешь в 2 раза дольше!`;

const tariffTexts = {
  help: 'ℹ️ Помощь',
  helpInfo: `ℹ️ Просто пришли ссылку и получишь mp3.  
🔓 Расширить — оплати и подтверди.  
🎵 Мои треки — список за сегодня.  
📋 Меню — тариф, лимиты, рефералы.  
📣 Канал: @SCM_BLOG`,

  limitReached: `🚫 Лимит достигнут ❌

💡 Чтобы качать больше треков, выбери тариф:

${tariffs}

${paymentInfo}

${bonusInfo}`,

  upgrade: '🚀 Расширить лимит',
  upgradeInfo: `🚀 Хочешь больше треков?
${tariffs}

${promoInfo}

${paymentInfo}

${bonusInfo}`,

  upgradePrompt: `🚀 Хочешь больше треков?
${tariffs}

${promoInfo}

${paymentInfo}

${bonusInfo}

Пожалуйста, отправь ссылку на трек или плейлист SoundCloud.`,

  mytracks: '🎵 Мои треки',
};

export const buttonTexts = {
  menu: '📋 Меню',
  help: tariffTexts.help,       // 'ℹ️ Помощь'
  upgrade: tariffTexts.upgrade, // '🚀 Расширить лимит'
  mytracks: tariffTexts.mytracks // '🎵 Мои треки'
};

export default tariffTexts;