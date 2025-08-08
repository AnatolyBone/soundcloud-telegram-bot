(function(){
  const root = document.documentElement;
  const saved = localStorage.getItem('theme');
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  root.setAttribute('data-theme', saved || (prefersDark ? 'dark':'light'));
  document.getElementById('themeToggle')?.addEventListener('click', ()=>{
    const cur = root.getAttribute('data-theme')==='dark'?'light':'dark';
    root.setAttribute('data-theme', cur);
    localStorage.setItem('theme', cur);
  });
  document.querySelectorAll('.alert[data-autohide]').forEach(el=>setTimeout(()=>el.classList.add('d-none'),4000));
})();