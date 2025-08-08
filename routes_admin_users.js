// routes/admin-users.js
import { getUsersPaginated, getUsersCSV, setPremium, updateUserField, getUserById } from '../db.js';

export default function setupAdminUsers(app) {
  // List users with pagination/sorting
  app.get('/admin/users', async (req, res) => {
    if (!req.session?.isAdmin) return res.redirect('/admin/login');
    const { q = '', sort = 'created_at', order = 'desc', page = '1', per_page = '20' } = req.query || {};
    const limit = Math.min(100, Math.max(1, parseInt(per_page) || 20));
    const p = Math.max(1, parseInt(page) || 1);
    const offset = (p - 1) * limit;
    const { rows, total } = await getUsersPaginated({ q, sort, order, limit, offset });
    const pages = Math.max(1, Math.ceil(total / limit));
    const fmt = (d) => d ? new Date(d).toLocaleString('ru-RU') : '—';

    // Simple HTML table, consistent with existing inline-admin style
    res.send(`<!doctype html><html lang="ru"><head>
      <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Пользователи — Админ</title>
      <link rel="stylesheet" href="/static/admin.css">
      <script defer src="/static/admin.js"></script>
      </head><body>
        <div class="container">
          <h1>Пользователи</h1>
          <form method="get" action="/admin/users" class="toolbar">
            <input type="text" name="q" placeholder="Поиск по ID/имени/@username" value="${String(q || '').replace(/"/g, '&quot;')}"/>
            <select name="sort">
              ${['created_at','last_active','username','id','premium_until','total_downloads','premium_limit'].map(s => 
                `<option value="${s}" ${s===sort?'selected':''}>${s}</option>`).join('')}
            </select>
            <select name="order">
              <option value="desc" ${order==='desc'?'selected':''}>desc</option>
              <option value="asc" ${order==='asc'?'selected':''}>asc</option>
            </select>
            <select name="per_page">
              ${[10,20,30,50,100].map(n=>`<option ${n==limit?'selected':''} value="${n}">${n}/стр</option>`).join('')}
            </select>
            <button type="submit">Применить</button>
            <a class="button" href="/admin/users.csv?q=${encodeURIComponent(q)}&sort=${sort}&order=${order}">Экспорт CSV</a>
            <a class="button" href="/dashboard">← Назад</a>
          </form>
          <div class="table-wrap">
          <table>
            <thead>
              <tr>
                ${[['id','ID'],['first_name','Имя'],['username','@username'],['created_at','Создан'],
                   ['last_active','Активность'],['premium_until','Премиум до'],['premium_limit','Лимит/день'],
                   ['total_downloads','Всего'],['actions','Действия']].map(([k,l])=>`<th>${l}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${rows.map(u => `<tr>
                <td>${u.id}</td>
                <td>${u.first_name||''}</td>
                <td>${u.username ? '@'+u.username : '—'}</td>
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
                    <button type="submit">Применить</button>
                  </form>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
          </div>
          <div class="pagination">
            ${Array.from({length: pages}, (_,i)=>i+1).map(n => {
              const url = `/admin/users?q=${encodeURIComponent(q)}&sort=${sort}&order=${order}&per_page=${limit}&page=${n}`;
              return `<a class="page ${n===p?'active':''}" href="${url}">${n}</a>`
            }).join('')}
          </div>
        </div>
      </body></html>`);
  });

  // CSV export
  app.get('/admin/users.csv', async (req, res) => {
    if (!req.session?.isAdmin) return res.redirect('/admin/login');
    const csv = await getUsersCSV(req.query || {});
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    res.send(csv);
  });

  // Change tariff
  app.post('/admin/users/:id/tariff', async (req, res) => {
    if (!req.session?.isAdmin) return res.redirect('/admin/login');
    const id = Number(req.params.id);
    const limit = Number(req.body?.limit || 0) || 0;
    const days = Number(req.body?.days || 0) || 0;
    if (!id || !limit) return res.status(400).send('Bad params');
    await setPremium(id, limit, days > 0 ? days : null);
    // Reset last activity? leave as is
    res.redirect('back');
  });
}
