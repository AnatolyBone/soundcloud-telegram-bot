(function() {
  const root = document.documentElement;
  const saved = localStorage.getItem('theme');
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  
  // Устанавливаем тему на основе локальных данных или предпочтений пользователя
  root.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));

  // Добавляем обработчик для переключения темы
  document.getElementById('themeToggle')?.addEventListener('click', () => {
    const currentTheme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', currentTheme);
    localStorage.setItem('theme', currentTheme);  // Сохраняем в localStorage
  });

  // Автоматическое скрытие уведомлений с задержкой в 4 секунды
  document.querySelectorAll('.alert[data-autohide]').forEach(el => {
    setTimeout(() => el.classList.add('d-none'), 4000);  // Скрываем уведомление через 4 секунды
  });
})();