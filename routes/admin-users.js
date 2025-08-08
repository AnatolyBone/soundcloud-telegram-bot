// routes/admin-users.js
import { query, setPremium } from '../db.js';

function whitelistSort(s) {
  const ok = new Set([
    'id','username','first_name','created_at','last_active',
    'premium_until','premium_limit','total_downloads'
  ]);
  return ok.has(s) ? s : 'created_at';
}

export default function setupAdminUsers(app) {
  // Список пользователей: поиск/сортировка/пагинация
  app.get('/admin/users', async (req, res) => {
    if (!req.session?.isAdmin) return res.redirect('/admin/login');

    const q = (req.query.q || '').toString();
    const sort = whitelistSort((req.query.sort || 'created_at').toString());
    const order = (req.query.order || 'desc').toString().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const per = Math.max(1, Math.min(100, parseInt(req.query.per_page) || 20));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * per;

    const params = [];
    let where = 'WHERE TRUE';
    if (q) {
      const safe = q.replace(/[%_]/g, '');
      params.push(`%${safe}%`);
      where += ` AND (CAST(id AS TEXT) ILIKE $${params.length}
               OR COALESCE(username,'') ILIKE $${params.length}
               OR COALESCE(first_name,'') ILIKE $${params.length})`;
    }

    const sql = `SELECT id, first_name, username, created_at, last_active,
                        premium_until, premium_limit, total_downloads
                 FROM users ${where}
                 ORDER BY ${sort} ${order}
                 LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    const countSql = `SELECT COUNT(*)::int AS c FROM users ${where}`;

    const { rows } = await query(sql, [...params, per, offset]);
    const total = (await query(countSql, params)).rows[0].c;
    const pages = Math.max(1, Math.ceil(total / per));
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
        form[action$="/tariff"] select, form[action$="/tariff"] input{height:30px}
        form[action$="/tariff"] button{height:32px}
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
            <option value="desc" ${order==='DESC'?'selected':''}>desc</option>
            <option value="asc" ${order==='ASC'?'selected':''}>asc</option>
          </select>
          <select name="per_page">
            ${[10,20,30,50,100].map(n=>`<option value="${n}" ${n===per?'selected':''}>${n}/стр</option>`).join('')}
          </select>
          <button type="submit">Применить</button>
          <a class="button" href="/admin/users.csv?q=${encodeURIComponent(q)}&sort=${sort}&order=${order}">Экспорт CSV</a>
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
              ${rows.map(u=>`<tr>
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
                      <option value="3">Free (3/д)</option>
                      <option value="10">Basic (10/д)</option>
                      <option value="30">Pro (30/д)</option>
                      <option value="999">∞ (999/д)</option>
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
            const url = `/admin/users?q=${encodeURIComponent(q)}&sort=${sort}&order=${order}&per_page=${per}&page=${n}`;
            return `<a class="page ${n===page?'active':''}" href="${url}">${n}</a>`;
          }).join('')}
        </div>
      </body></html>`);
  });

  // CSV экспорт
  app.get('/admin/users.csv', async (req, res) => {
    if (!req.session?.isAdmin) return res.redirect('/admin/login');

    const q = (req.query.q || '').toString();
    const sort = whitelistSort((req.query.sort || 'created_at').toString());
    const order = (req.query.order || 'desc').toString().toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const params = [];
    let where = 'WHERE TRUE';
    if (q) {
      const safe = q.replace(/[%_]/g, '');
      params.push(`%${safe}%`);
      where += ` AND (CAST(id AS TEXT) ILIKE $${params.length}
               OR COALESCE(username,'') ILIKE $${params.length}
               OR COALESCE(first_name,'') ILIKE $${params.length})`;
    }

    const { rows } = await query(
      `SELECT id, first_name, username, created_at, last_active, premium_until, premium_limit, total_downloads
       FROM users ${where} ORDER BY ${sort} ${order} LIMIT 10000`, params);

    const header = 'id,first_name,username,created_at,last_active,premium_until,premium_limit,total_downloads\n';
    const csv = header + rows.map(r => [
      r.id,
      JSON.stringify(r.first_name||''),
      JSON.stringify(r.username||''),
      r.created_at, r.last_active, r.premium_until,
      r.premium_limit ?? 0, r.total_downloads ?? 0
    ].join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    res.send(csv);
  });

  // Смена тарифа
  app.post('/admin/users/:id/tariff', async (req, res) => {
    if (!req.session?.isAdmin) return res.redirect('/admin/login');
    const id = Number(req.params.id);
    const limit = Number(req.body?.limit || 0) || 0;
    const days = Number(req.body?.days || 0) || 0;
    if (!id || !limit) return res.status(400).send('Bad params');
    await setPremium(id, limit, days > 0 ? days : null);
    res.redirect('back');
  });
}