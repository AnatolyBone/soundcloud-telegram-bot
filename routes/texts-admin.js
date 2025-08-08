// routes/texts-admin.js
import express from 'express';
import { loadTexts, allTextsSync, setText } from '../config/texts.js';

export default function setupTextsAdmin({ app, requireAuth }) {
  const router = express.Router();

  // форма редактирования
  router.get('/', requireAuth, async (req, res) => {
    await loadTexts(true);
    const data = allTextsSync();

    res.send(`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Тексты бота</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
<style>textarea{min-height:110px}</style>
</head>
<body class="container py-4">
<h3 class="mb-3">Редактирование текстов</h3>
<form method="post" action="/admin/texts">
  ${Object.entries(data).map(([key, val]) => `
    <div class="mb-3">
      <label class="form-label"><b>${key}</b></label>
      <textarea class="form-control" name="${key}">${(val || '').replace(/</g,'&lt;')}</textarea>
    </div>
  `).join('')}
  <button class="btn btn-primary">Сохранить</button>
  <a class="btn btn-outline-secondary" href="/dashboard">Назад</a>
</form>
</body></html>`);
  });

  // сохранение
  router.post('/', requireAuth, express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const entries = Object.entries(req.body || {});
      for (const [key, value] of entries) {
        await setText(key, String(value ?? ''));
      }
      await loadTexts(true);
      res.redirect('/admin/texts');
    } catch (e) {
      console.error('[texts-admin] save error:', e);
      res.status(500).send('Ошибка сохранения: ' + e.message);
    }
  });

  app.use('/admin/texts', router);
}