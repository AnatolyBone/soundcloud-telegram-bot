# soundcloud-telegram-bot

soundcloud-telegram-bot/
│
├── index.js                  # основной запуск
├── bot/
│   ├── handlers/             # реакции на команды, текст и т.д.
│   ├── middleware/           # мидлвары (например, лимиты)
│   └── utils/                # вспомогательные функции
│       ├── cache.js
│       ├── audio.js
│       ├── user.js
│       ├── text.js
│       ├── queue.js
│       ├── referral.js
│       ├── logger.js
│       └── helper.js         # мелкие утилиты: getDaysLeft, extractUrl и т.д.
├── routes/
│   └── admin.js              # маршруты админки
├── views/
│   └── layout.ejs
├── public/
├── .env
└── package.json