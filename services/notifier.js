// services/notifier.js

import { findUsersToNotify, markAsNotified, updateUserField } from '../db.js';

let botInstance = null;

/**
 * Инициализирует модуль, передавая ему экземпляр бота.
 * @param {Telegraf} bot - Экземпляр Telegraf.
 */
export function initNotifier(bot) {
    if (!bot) {
        throw new Error("Экземпляр бота должен быть предоставлен для инициализации notifier.");
    }
    botInstance = bot;
}

/**
 * Запускает фоновый процесс, который раз в час проверяет,
 * не пора ли отправить уведомления об истечении подписки.
 */
export async function startNotifier() {
    if (!botInstance) {
        console.error('🔴 Notifier не был инициализирован. Вызовите initNotifier(bot) перед запуском.');
        return;
    }
    
    console.log('🚀 Запуск планировщика уведомлений...');
    
    let lastNotificationDate = null; 

    const checkAndNotify = async () => {
        const now = new Date();
        const currentHour = now.getUTCHours();
        const currentDate = now.toISOString().slice(0, 10);

        // Условие для запуска: 10 утра по UTC и в эту дату мы еще не отправляли
        if (currentHour === 10 && currentDate !== lastNotificationDate) {
            console.log(`[Notifier] Настало время для ежедневной рассылки (${currentDate}).`);
            lastNotificationDate = currentDate;

            try {
                const users = await findUsersToNotify(3); // Ищем тех, у кого тариф истекает через 3 дня

                if (users.length === 0) {
                    console.log('[Notifier] Пользователей для уведомления нет.');
                    return;
                }

                console.log(`[Notifier] Найдено ${users.length} пользователей. Начинаю рассылку...`);
                for (const user of users) {
                    const daysLeft = Math.ceil((new Date(user.premium_until) - new Date()) / (1000 * 60 * 60 * 24));
                    const daysWord = daysLeft === 1 ? 'день' : (daysLeft > 1 && daysLeft < 5 ? 'дня' : 'дней');
                    
                    const message = `👋 Привет, ${user.first_name}!\n\n` +
                                    `Напоминаем, что ваша подписка истекает через ${daysLeft} ${daysWord}. ` +
                                    `Не забудьте продлить ее, чтобы сохранить доступ ко всем возможностям!\n\n` +
                                    `Нажмите /upgrade, чтобы посмотреть доступные тарифы.`;

                    try {
                        await botInstance.telegram.sendMessage(user.id, message);
                        await markAsNotified(user.id);
                        console.log(`✅ Уведомление отправлено пользователю ${user.id}`);
                    } catch (e) {
                        if (e.response?.error_code === 403) {
                            console.warn(`[Notifier] Пользователь ${user.id} заблокировал бота. Деактивируем...`);
                            await updateUserField(user.id, 'active', false);
                        } else {
                            console.error(`❌ Ошибка отправки сообщения пользователю ${user.id}:`, e.message);
                        }
                    }
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
                console.log('[Notifier] Ежедневная рассылка завершена.');
            } catch (e) {
                console.error('🔴 Критическая ошибка в процессе рассылки уведомлений:', e);
            }
        }
    };

    // Запускаем проверку сразу и потом каждый час
    checkAndNotify();
    setInterval(checkAndNotify, 60 * 60 * 1000);
}