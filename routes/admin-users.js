// routes/admin-users.js
import { supabase, setPremium } from '../db.js';

function whitelistSort(s) {
  const ok = new Set([
    'id', 'username', 'first_name', 'created_at', 'last_active',
    'premium_until', 'premium_limit', 'total_downloads'
  ]);
  return ok.has(s) ? s : 'created_at';
}

export default function setupAdminUsers(app) {
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

      res.send(`<!doctype html><html lang="ru"><head>
        <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
        <title>Пользователи — Админ</title>
        <link rel="stylesheet" href="/static/admin.css">
        <script defer src="/static/admin.js"></script>
        <style>
          body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif;padding:16px}
          .toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
          .table-wrap{overflow:auto;border:1px solid #ddd;border-radius:8px}
          table{border-collapse:collapse;width:100%}
          th,td{padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap}
          th{background:#fafafa;text-align:left}
          .pagination{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}
          .page{padding:6px 10px;border:1px solid #ddd;border-radius:6px;text-decoration:none}
          .active{background:#eee}
          .button{padding:6px 10px;border:1px solid #ddd;border-radius:6px;text-decoration:none}
        </style>
        </head><body>
          <h1>Пользователи</h1>
          <form method="get" action="/admin/users" class="toolbar">
            <input type="text" name="q" placeholder="Поиск по ID/имени/@username" value="${String(q).replace(/"/g,'&quot;')}"/>
            <select name="sort">
              ${['created_at','last_active','username','id','premium_until','total_downloads','premium_limit']
                .map(s=>`<option value="${s}" ${s===sort?'selected':''}>${s}</option>`).join('')}
            </select>
            <select name="order">
              <option value="desc" ${!asc?'selected':''}>desc</option>
              <option value="asc" ${asc?'selected':''}>asc</option>
            </select>
            <select name="status">
              <option value="">Все</option>
              <option value="active" ${status === 'active' ? 'selected' : ''}>Активные</option>
              <option value="inactive" ${status === 'inactive' ? 'selected' : ''}>Неактивные</option>
            </select>
            <select name="per_page">
              ${[10,20,30,50,100].map(n=>`<option value="${n}" ${n===per?'selected':''}>${n}/стр</option>`).join('')}
            </select>
            <button type="submit">Применить</button>
            <a class="button" href="/admin/users.csv?q=${encodeURIComponent(q)}&sort=${sort}&order=${asc?'asc':'desc'}">Экспорт CSV</a>
            <a class="button" href="/dashboard">← Назад</a>
          </form>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th><th>Имя</th><th>@username</th><th>Создан</th>
                  <th>Активность</th><th>Премиум до</th><th>Лимит/день</th><th>Всего</th><th>Действия</th>
                </tr>
              </thead>
              <tbody>
                ${(rows||[]).map(u=>`<tr>
                  <td>${u.id}</td>
                  <td>${u.first_name||''}</td>
                  <td>${u.username?('@'+u.username):'—'}</td>
                  <td>${fmt(u.created_at)}</td>
                  <td>${fmt(u.last_active)}</td>
                  <td>${fmt(u.premium_until)}</td>
                  <td>${u.premium_limit ?? 0}</td>
                  <td>${u.total_downloads ?? 0}</td>
                  <td>
                    <form method="post" action="/admin/users/${u.id}/tariff" style="display:flex;gap:6px;align-items:center">
                      <select name="limit">
                        <option value="5">Free (5/д)</option>
                        <option value="30">Plus (30/д)</option>
                        <option value="100">Pro (100/д)</option>
                        <option value="1000">∞ (1000/д)</option>
                      </select>
                      <input type="number" name="days" min="1" value="30" style="width:70px" title="+дней">
                      <button type="submit">OK</button>
                    </form>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>

          <div class="pagination">
            ${Array.from({length: pages},(_,i)=>i+1).map(n=>{
              const url = `/admin/users?q=${encodeURIComponent(q)}&sort=${sort}&order=${asc ? 'asc' : 'desc'}&per_page=${per}&page=${n}`;
              return `<a class="page ${n===page?'active':''}" href="${url}">${n}</a>`;
            }).join('')}
          </div>
        </body></html>`);
    } catch (e) {
      console.error('[admin/users] GET error:', e);
      res
        .status(500)
        .send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:20px">
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
  app.post('/admin/users/:id/tariff', async (req, res) => {
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