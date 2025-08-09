import { supabase, setPremium } from '../db.js';
import csrf from 'csurf';

function whitelistSort(s) {
  const ok = new Set([
    'id', 'username', 'first_name', 'created_at', 'last_active',
    'premium_until', 'premium_limit', 'total_downloads'
  ]);
  return ok.has(s) ? s : 'created_at';
}

export default function setupAdminUsers(app) {
  const csrfProtection = csrf({ cookie: true });

  // Список пользователей: поиск/сортировка/пагинация (через Supabase)
  app.get('/admin/users', async (req, res) => {
    if (!req.session?.isAdmin) return res.redirect('/admin/login');

    const q = (req.query.q || '').toString();
    const status = req.query.status || '';
    const sort = whitelistSort((req.query.sort || 'created_at').toString());
    const asc = ((req.query.order || 'desc').toString().toLowerCase() === 'asc');
    const per = Math.max(1, Math.min(100, parseInt(req.query.per_page) || 20));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * per;
    const from = offset;
    const to = offset + per - 1;

    const safe = q.replace(/[%_,]/g, '').trim();
    const orFilter = safe
      ? `id::text.ilike.%${safe}%,username.ilike.%${safe}%,first_name.ilike.%${safe}%`
      : null;

    let query = supabase
      .from('users')
      .select('id, first_name, username, created_at, last_active, premium_until, premium_limit, total_downloads', { count: 'exact' });

    if (orFilter) query = query.or(orFilter);
    if (status) query = query.eq('active', status === 'active' ? true : false);
    query = query.order(sort, { ascending: asc, nullsFirst: false }).range(from, to);

    try {
      const { data: rows, count: total, error } = await query;
      if (error) throw error;

      const pages = Math.max(1, Math.ceil((total || 0) / per));
      const fmt = (d) => d ? new Date(d).toLocaleString('ru-RU') : '—';

      res.render('users', { 
        rows, total, pages, page, per, q, status, sort, asc, fmt, csrfToken: req.csrfToken() 
      });
    } catch (e) {
      console.error('[admin/users] GET error:', e);
      res.status(500).send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:20px">
<h1>Ошибка загрузки списка пользователей</h1>
<p style="color:#b91c1c">${(e?.message || e)?.toString()}</p>
<p><a href="/dashboard">← Назад</a></p>
</body>`);
    }
  });

  // CSV экспорт (через Supabase)
  app.get('/admin/users.csv', async (req, res) => {
    if (!req.session?.isAdmin) return res.redirect('/admin/login');

    const q = (req.query.q || '').toString();
    const sort = whitelistSort((req.query.sort || 'created_at').toString());
    const asc = ((req.query.order || 'desc').toString().toLowerCase() === 'asc');

    const safe = q.replace(/[%_,]/g, '').trim();
    const orFilter = safe
      ? `id::text.ilike.%${safe}%,username.ilike.%${safe}%,first_name.ilike.%${safe}%`
      : null;

    try {
      let query = supabase
        .from('users')
        .select('id, first_name, username, created_at, last_active, premium_until, premium_limit, total_downloads');

      if (orFilter) query = query.or(orFilter);
      query = query.order(sort, { ascending: asc, nullsFirst: false }).limit(10000);

      const { data: rows, error } = await query;
      if (error) throw error;

      const header = 'id,first_name,username,created_at,last_active,premium_until,premium_limit,total_downloads\n';
      const csv = header + (rows||[]).map(r => [
        r.id,
        JSON.stringify(r.first_name||''),
        JSON.stringify(r.username||''),
        r.created_at ?? '',
        r.last_active ?? '',
        r.premium_until ?? '',
        r.premium_limit ?? 0,
        r.total_downloads ?? 0
      ].join(',')).join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
      res.send(csv);
    } catch (e) {
      console.error('[admin/users.csv] error:', e);
      res.status(500).send('Ошибка экспорта CSV');
    }
  });

  // Смена тарифа
  app.post('/admin/users/:id/tariff', csrfProtection, async (req, res) => {
    if (!req.session?.isAdmin) return res.redirect('/admin/login');
    const id = Number(req.params.id);
    const limit = Number(req.body?.limit || 0) || 0;
    const days = Number(req.body?.days || 0) || 0;
    if (!id || !limit) return res.status(400).send('Bad params');
    try {
      await setPremium(id, limit, days > 0 ? days : null);
      res.redirect('back');
    } catch (e) {
      console.error('[admin/tariff] error:', e);
      res.status(500).send('Ошибка смены тарифа');
    }
  });
}