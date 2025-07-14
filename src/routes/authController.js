// controllers/authController.js
export const loginForm = (req, res) => {
  res.render('login', { title: 'Вход в админку', error: null });
};

export const loginSubmit = (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_LOGIN && password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    req.session.userId = Number(process.env.ADMIN_ID);
    return res.redirect('/dashboard');
  }
  res.render('login', { title: 'Вход в админку', error: 'Неверный логин или пароль' });
};

export const logout = (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
};