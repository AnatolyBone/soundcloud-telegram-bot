// tariff.js

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
  limitReached: `🚫 Лимит достигнут ❌

💡 Чтобы качать больше треков, выбери тариф:

${tariffs}

${paymentInfo}

${bonusInfo}`,

  upgradeInfo: `🚀 Хочешь больше треков?
${tariffs}

${promoInfo}

${paymentInfo}

${bonusInfo}`,
};

export default tariffTexts;