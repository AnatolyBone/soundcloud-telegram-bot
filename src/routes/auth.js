// routes/auth.js
import express from 'express';
import { loginForm, loginSubmit, logout } from '../controllers/authController.js';

const router = express.Router();

router.get('/admin', loginForm);
router.post('/admin', loginSubmit);
router.get('/logout', logout);

export default router;