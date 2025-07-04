<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <title>Admin Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <!-- AdminLTE CSS -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/admin-lte@3.2/dist/css/adminlte.min.css" />
  <!-- Font Awesome Icons -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
  <!-- DataTables CSS -->
  <link rel="stylesheet" href="https://cdn.datatables.net/1.13.6/css/dataTables.bootstrap4.min.css" />
  <!-- Chart.js -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <!-- jQuery -->
  <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
  <!-- Bootstrap 4 JS -->
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@4.6.2/dist/js/bootstrap.bundle.min.js"></script>
  <!-- DataTables JS -->
  <script src="https://cdn.datatables.net/1.13.6/js/jquery.dataTables.min.js"></script>
  <script src="https://cdn.datatables.net/1.13.6/js/dataTables.bootstrap4.min.js"></script>
  <style>
    /* Немного кастомных стилей для подсказок и высоты контента */
    .content-wrapper {
      min-height: 90vh;
    }
  </style>
</head>
<body class="hold-transition sidebar-mini">
<div class="wrapper">

  <!-- Навигационная панель сверху -->
  <nav class="main-header navbar navbar-expand navbar-white navbar-light">
    <!-- Левая часть -->
    <ul class="navbar-nav">
      <li class="nav-item">
        <a class="nav-link" data-widget="pushmenu" href="#" role="button" title="Меню"><i class="fas fa-bars"></i></a>
      </li>
      <li class="nav-item d-none d-sm-inline-block">
        <a href="/dashboard" class="nav-link">Главная</a>
      </li>
    </ul>
    <!-- Правая часть -->
    <ul class="navbar-nav ml-auto">
      <li class="nav-item">
        <a href="/logout" class="nav-link" title="Выйти"><i class="fas fa-sign-out-alt"></i></a>
      </li>
    </ul>
  </nav>

  <!-- Боковая панель -->
  <aside class="main-sidebar sidebar-dark-primary elevation-4">
    <!-- Логотип -->
    <a href="/dashboard" class="brand-link">
      <i class="fas fa-music ml-2"></i>
      <span class="brand-text font-weight-light ml-2">BAZA Admin</span>
    </a>

    <!-- Меню -->
    <div class="sidebar">
      <nav class="mt-2">
        <ul class="nav nav-pills nav-sidebar flex-column" data-widget="treeview" role="menu">
          <li class="nav-item">
            <a href="/dashboard" class="nav-link <%= page === 'dashboard' ? 'active' : '' %>">
              <i class="nav-icon fas fa-tachometer-alt"></i>
              <p>Панель управления</p>
            </a>
          </li>
          <li class="nav-item">
            <a href="/users" class="nav-link <%= page === 'users' ? 'active' : '' %>">
              <i class="nav-icon fas fa-users"></i>
              <p>Пользователи</p>
            </a>
          </li>
          <li class="nav-item">
            <a href="/broadcast" class="nav-link <%= page === 'broadcast' ? 'active' : '' %>">
              <i class="nav-icon fas fa-bullhorn"></i>
              <p>Массовая рассылка</p>
            </a>
          </li>
          <li class="nav-item">
            <a href="/settings" class="nav-link <%= page === 'settings' ? 'active' : '' %>">
              <i class="nav-icon fas fa-cogs"></i>
              <p>Настройки</p>
            </a>
          </li>
        </ul>
      </nav>
    </div>
  </aside>

  <!-- Основной контент -->
  <div class="content-wrapper">
    <!-- Заголовок страницы -->
    <section class="content-header">
      <div class="container-fluid">
        <div class="row mb-2">
          <div class="col-sm-6">
            <h1>📊 Админка</h1>
          </div>
          <div class="col-sm-6 text-right">
            <small>Пользователь: <%= user ? user.username || user.first_name : 'Гость' %></small>
          </div>
        </div>
      </div>
    </section>

    <!-- Основной блок контента -->
    <section class="content">
      <div class="container-fluid">
        <!-- Вкладки -->
        <ul class="nav nav-tabs" id="dashboardTabs" role="tablist">
          <li class="nav-item">
            <a class="nav-link active" id="stats-tab" data-toggle="tab" href="#stats" role="tab" aria-controls="stats" aria-selected="true">Статистика</a>
          </li>
          <li class="nav-item">
            <a class="nav-link" id="users-tab" data-toggle="tab" href="#usersTab" role="tab" aria-controls="usersTab" aria-selected="false">Пользователи</a>
          </li>
          <li class="nav-item">
            <a class="nav-link" id="broadcast-tab" data-toggle="tab" href="#broadcastTab" role="tab" aria-controls="broadcastTab" aria-selected="false">Рассылка</a>
          </li>
        </ul>

        <div class="tab-content" id="dashboardTabsContent" style="margin-top:20px;">
          <!-- Вкладка Статистика -->
          <div class="tab-pane fade show active" id="stats" role="tabpanel" aria-labelledby="stats-tab">

            <form method="GET" action="/dashboard" class="form-inline mb-3">
              <div class="form-check mr-3">
                <input class="form-check-input" type="checkbox" id="showInactive" name="showInactive" value="true" <%= showInactive ? 'checked' : '' %>>
                <label class="form-check-label" for="showInactive">Показать неактивных</label>
              </div>
              <button type="submit" class="btn btn-primary btn-sm">Обновить</button>
              <a href="/export" class="btn btn-secondary btn-sm ml-3">📁 Экспорт в CSV</a>
            </form>

            <div class="row mb-3">
              <div class="col-md-4">
                <div class="info-box bg-info">
                  <span class="info-box-icon"><i class="fas fa-users"></i></span>
                  <div class="info-box-content">
                    <span class="info-box-text">Всего пользователей</span>
                    <span class="info-box-number"><%= stats.totalUsers %></span>
                  </div>
                </div>
              </div>
              <div class="col-md-4">
                <div class="info-box bg-success">
                  <span class="info-box-icon"><i class="fas fa-download"></i></span>
                  <div class="info-box-content">
                    <span class="info-box-text">Всего загрузок</span>
                    <span class="info-box-number"><%= stats.totalDownloads %></span>
                  </div>
                </div>
              </div>
              <div class="col-md-4">
                <div class="info-box bg-warning">
                  <span class="info-box-icon"><i class="fas fa-star"></i></span>
                  <div class="info-box-content">
                    <span class="info-box-text">Тарифы (Free/Plus/Pro/Unlim)</span>
                    <span class="info-box-number">
                      Free: <%= stats.free %>, Plus: <%= stats.plus %>, Pro: <%= stats.pro %>, Unlim: <%= stats.unlimited %>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Графики -->
            <div class="card card-primary card-outline">
              <div class="card-header">
                <h3 class="card-title">Регистрации, Загрузки, Активные</h3>
              </div>
              <div class="card-body">
                <canvas id="combinedChart" style="height: 250px;"></canvas>
              </div>
            </div>

            <div class="row mt-3">
              <div class="col-md-6">
                <div class="card card-info card-outline">
                  <div class="card-header">
                    <h3 class="card-title">Активность по часам</h3>
                  </div>
                  <div class="card-body">
                    <canvas id="hourActivityChart" style="height: 250px;"></canvas>
                  </div>
                </div>
              </div>
              <div class="col-md-6">
                <div class="card card-info card-outline">
                  <div class="card-header">
                    <h3 class="card-title">Активность по дням недели</h3>
                  </div>
                  <div class="card-body">
                    <canvas id="weekdayActivityChart" style="height: 250px;"></canvas>
                  </div>
                </div>
              </div>
            </div>

            <!-- Тепловая карта -->
            <div class="card card-secondary card-outline mt-3">
              <div class="card-header">
                <h3 class="card-title">Активность по дате и часу (тепловая карта)</h3>
              </div>
              <div class="card-body" style="height: 400px;">
                <canvas id="heatmapChart"></canvas>
              </div>
              <details class="mt-3">
                <summary>Показать данные активности по дате и часу (JSON)</summary>
                <pre><%= JSON.stringify(stats.activityByDayHour || {}, null, 2) %></pre>
              </details>
            </div>

            <!-- С тарифом, истекающим в ближайшие 3 дня -->
            <div class="card card-danger card-outline mt-3">
              <div class="card-header">
                <h3 class="card-title">С тарифом, истекающим в ближайшие 3 дня</h3>
              </div>
              <div class="card-body">
                <% if (expiringSoon.length === 0) { %>
                  <p>Нет таких пользователей</p>
                <% } else { %>
                  <ul class="list-group">
                    <% expiringSoon.forEach(u => { %>
                      <li class="list-group-item d-flex justify-content-between align-items-center">
                        <span><%= u.first_name %> (<%= u.username ? '@' + u.username : '—' %>)</span>
                        <span>До <%= new Date(u.premium_until).toLocaleDateString() %></span>
                      </li>
                    <% }) %>
                  </ul>

                  <nav aria-label="Page navigation example" class="mt-3">
                    <ul class="pagination justify-content-center">
                      <% if (expiringOffset > 0) { %>
                        <li class="page-item">
                          <button class="page-link" onclick="changePage(-1)">← Назад</button>
                        </li>
                      <% } %>
                      <% if (expiringOffset + expiringLimit < expiringCount) { %>
                        <li class="page-item">
                          <button class="page-link" onclick="changePage(1)">Вперёд →</button>
                        </li>
                      <% } %>
                    </ul>
                    <p class="text-center text-muted">Показано <%= expiringOffset + 1 %>–<%= Math.min(expiringOffset + expiringLimit, expiringCount) %> из <%= expiringCount %></p>
                  </nav>
                <% } %>
              </div>
            </div>

            <!-- Источники трафика -->
            <div class="card card-light card-outline mt-3">
              <div class="card-header">
                <h3 class="card-title">Источники трафика</h3>
              </div>
              <div class="card-body p-0">
                <table class="table table-striped table-hover mb-0">
                  <thead class="thead-light">
                    <tr>
                      <th>Источник</th>
                      <th>Кол-во</th>
                    </tr>
                  </thead>
                  <tbody>
                    <% referralStats.forEach(source => { %>
                      <tr>
                        <td><%= source.source || '—' %></td>
                        <td><%= source.count %></td>
                      </tr>
                    <% }) %>
                  </tbody>
                </table>
              </div>
            </div>

          </div>

          <!-- Вкладка Пользователи -->
          <div class="tab-pane fade" id="usersTab" role="tabpanel" aria-labelledby="users-tab">

            <table id="usersTable" class="table table-bordered table-hover" style="width:100%;">
              <thead>
                <tr>
                  <th>ID</th><th>Username</th><th>Имя</th><th>Скачано</th><th>Лимит</th>
                  <th>Регистрация</th><th>Активность</th><th>Статус</th><th>Источник</th><th>Тариф</th>
                </tr>
              </thead>
              <tbody>
                <% users.forEach(user => { %>
                  <tr class="<%= !user.active ? 'table-secondary' : '' %>">
                    <td><%= user.id %></td>
                    <td><%= user.username ? '@' + user.username : '' %></td>
                    <td>
                      <%= user.first_name %> 
                      <% if (new Date(user.created_at) > Date.now() - 24 * 60 * 60 * 1000) { %> <span class="badge badge-info">🆕</span> <% } %>
                    </td>
                    <td><%= user.total_downloads || 0 %></td>
                    <td><%= user.premium_limit %></td>
                    <td><%= user.created_at ? new Date(user.created_at).toLocaleDateString() : '-' %></td>
                    <td><%= user.last_active ? new Date(user.last_active).toLocaleDateString() : '-' %></td>
                    <td>
                      <% if (!user.last_active) { %>🔴
                      <% } else if (new Date(user.last_active) > Date.now() - 24 * 60 * 60 * 1000) { %>🟢
                      <% } else { %>🟡<% } %>
                    </td>
                    <td><%= user.referral_source || '—' %></td>
                    <td>
                      <form method="POST" action="/set-tariff" class="form-inline m-0">
                        <input type="hidden" name="userId" value="<%= user.id %>">
                        <select name="limit" class="form-control form-control-sm mr-2">
                          <option value="10" <%= user.premium_limit === 10 ? 'selected' : '' %>>Free</option>
                          <option value="50" <%= user.premium_limit === 50 ? 'selected' : '' %>>Plus</option>
                          <option value="100" <%= user.premium_limit === 100 ? 'selected' : '' %>>Pro</option>
                          <option value="1000" <%= user.premium_limit >= 1000 ? 'selected' : '' %>>Unlimited</option>
                        </select>
                        <button type="submit" class="btn btn-primary btn-sm">Сохранить</button>
                      </form>
                    </td>
                  </tr>
                <% }) %>
              </tbody>
            </table>
          </div>

          <!-- Вкладка Рассылка -->
          <div class="tab-pane fade" id="broadcastTab" role="tabpanel" aria-labelledby="broadcast-tab">
            <form method="POST" action="/broadcast" enctype="multipart/form-data">
              <div class="form-group">
                <label for="broadcastMessage">Сообщение</label>
                <textarea id="broadcastMessage" name="message" class="form-control" rows="4" required placeholder="Введите текст"></textarea>
              </div>
              <div class="form-group">
                <label for="broadcastAudio">Аудиофайл (mp3)</label>
                <input type="file" id="broadcastAudio" name="audio" accept="audio/mp3,audio/mpeg" class="form-control-file" />
              </div>
              <button type="submit" class="btn btn-success">Отправить</button>
            </form>
          </div>
        </div>
      </div>
    </section>
  </div>

  <!-- Футер -->
  <footer class="main-footer text-sm text-center">
    <strong>© 2025 BAZA</strong> — админка Telegram-бота
  </footer>

</div>

<script>
  $(function () {
    // Инициализация тултипов (всплывающих подсказок)
    $('[data-toggle="tooltip"]').tooltip();

    // Инициализация DataTables
    $('#usersTable').DataTable({
      order: [[5, 'desc']],
      language: {
        search: "Поиск:",
        lengthMenu: "Показать _MENU_ записей",
        info: "Показано _START_ - _END_ из _TOTAL_",
        paginate: {
          first: "Первая", last: "Последняя", next: "Следующая", previous: "Предыдущая"
        },
        zeroRecords: "Нет данных"
      }
    });

    // Данные для графиков
    const combinedLabels = <%- JSON.stringify(Object.keys(stats.registrationsByDate)) %>;
    const registrationsData = <%- JSON.stringify(Object.values(stats.registrationsByDate)) %>;
    const downloadsData = <%- JSON.stringify(Object.values(stats.downloadsByDate)) %>;
    const activeUsersData = <%- JSON.stringify(Object.values(stats.activeByDate)) %>;

    new Chart(document.getElementById('combinedChart'), {
      type: 'line',
      data: {
        labels: combinedLabels,
        datasets: [
          {
            label: 'Регистрарации',
            data: registrationsData,
            borderColor: '#007bff',
            backgroundColor: 'rgba(0, 123, 255, 0.3)',
            fill: true,
            tension: 0.3,
          },
          {
            label: 'Загрузки',
            data: downloadsData,
            borderColor: '#28a745',
            backgroundColor: 'rgba(40, 167, 69, 0.3)',
            fill: true,
            tension: 0.3,
          },
          {
            label: 'Активные пользователи',
            data: activeUsersData,
            borderColor: '#ffc107',
            backgroundColor: 'rgba(255, 193, 7, 0.3)',
            fill: true,
            tension: 0.3,
          }
        ]
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        stacked: false,
        scales: { y: { beginAtZero: true } }
      }
    });

    // Активность по часам
    const hoursLabels = Array.from({length:24}, (_,i) => i + ':00');
    const activityByHour = <%- JSON.stringify(stats.activityByHour || Array(24).fill(0)) %>;

    new Chart(document.getElementById('hourActivityChart'), {
      type: 'bar',
      data: {
        labels: hoursLabels,
        datasets: [{
          label: 'Активность по часам',
          data: activityByHour,
          backgroundColor: 'rgba(0, 123, 255, 0.7)',
          borderColor: 'rgba(0, 123, 255, 1)',
          borderWidth: 1
        }]
      },
      options: {
        scales: {
          y: { beginAtZero: true },
          x: { title: { display: true, text: 'Часы' } }
        }
      }
    });

    // Активность по дням недели
    const weekdaysLabels = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const activityByWeekday = <%- JSON.stringify(stats.activityByWeekday || Array(7).fill(0)) %>;

    new Chart(document.getElementById('weekdayActivityChart'), {
      type: 'bar',
      data: {
        labels: weekdaysLabels,
        datasets: [{
          label: 'Активность по дням недели',
          data: activityByWeekday,
          backgroundColor: 'rgba(40, 167, 69, 0.7)',
          borderColor: 'rgba(40, 167, 69, 1)',
          borderWidth: 1
        }]
      },
      options: {
        scales: {
          y: { beginAtZero: true },
          x: { title: { display: true, text: 'Дни недели' } }
        }
      }
    });

    // Тепловая карта активности по дате и часу
    const activityByDayHour = <%- JSON.stringify(stats.activityByDayHour || {}) %>;
    const days = Object.keys(activityByDayHour).sort();
    const hours = Array.from({length: 24}, (_, i) => i);

    const heatmapDatasets = hours.map(hour => ({
      label: hour + ':00',
      data: days.map(day => (activityByDayHour[day] ? activityByDayHour[day][hour] || 0 : 0)),
      backgroundColor: function(context) {
        const value = context.dataset.data[context.dataIndex];
        const alpha = Math.min(value / 3, 1);
        return `rgba(54, 162, 235, ${alpha})`;
      },
      borderWidth: 0
    }));

    const ctxHeatmap = document.getElementById('heatmapChart').getContext('2d');
    new Chart(ctxHeatmap, {
      type: 'bar',
      data: {
        labels: days,
        datasets: heatmapDatasets
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        scales: {
          x: {
            stacked: true,
            beginAtZero: true,
            title: { display: true, text: 'Активность' }
          },
          y: {
            stacked: true,
            title: { display: true, text: 'Дата' },
            ticks: { autoSkip: true, maxTicksLimit: 10 }
          }
        },
        plugins: {
          legend: { display: true, position: 'top' },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${ctx.parsed.x}`
            }
          }
        }
      }
    });

    // Пагинация для истекающих тарифов
    function changePage(delta) {
      const offsetInput = document.getElementById('expiringOffset');
      let offset = parseInt(offsetInput.value, 10) || 0;
      const limit = parseInt(document.getElementById('expiringLimit').value, 10) || 10;
      offset += delta * limit;
      if (offset < 0) offset = 0;
      offsetInput.value = offset;
      document.getElementById('paginationForm').submit();
    }
  });
</script>
</body>
</html>