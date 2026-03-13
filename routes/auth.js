import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import db from '../db.js';
import { JWT_SECRET, JWT_REFRESH_SECRET, authenticate } from '../middleware/auth.js';

const router = Router();

// ==================== HELPERS ====================

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateAccessToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '15m' });
}

function generateRefreshToken(userId) {
  return jwt.sign({ userId }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
}

// ==================== RATE LIMITING ====================

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 5, 
  message: { success: false, error: 'Too many OTP requests. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ==================== ROUTES ====================

/**
 * POST /api/auth/send-otp
 * Body: { phone: string, name?: string }
 */
router.post('/send-otp', otpLimiter, (req, res, next) => {
  try {
    let { phone, name } = req.body;

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, error: 'Phone number is required.' });
    }

    // Normalize phone — keep only digits
    phone = phone.replace(/\D/g, '');
    if (phone.length < 10 || phone.length > 15) {
      return res.status(400).json({ success: false, error: 'Invalid phone number. Must be 10-15 digits.' });
    }

    // Clean up expired OTPs for this phone
    db.prepare("DELETE FROM otp_codes WHERE phone = ? OR expires_at < datetime('now')").run(phone);

    // Generate OTP
    const otp = generateOtp();
    const otpHash = hashValue(otp);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    db.prepare('INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES (?, ?, ?)').run(phone, otpHash, expiresAt);

    // In production, send OTP via SMS gateway here
    console.log(`📱 OTP for ${phone}: ${otp}`);

    // Dev mode — return OTP in response for testing
    res.json({
      success: true,
      message: 'OTP sent successfully.',
      // DEV ONLY — remove in production
      dev_otp: otp,
      phone,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/verify-otp
 * Body: { phone: string, otp: string, name?: string }
 */
router.post('/verify-otp', (req, res, next) => {
  try {
    let { phone, otp, name } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, error: 'Phone and OTP are required.' });
    }

    phone = phone.replace(/\D/g, '');
    const otpHash = hashValue(otp);

    // Find valid OTP
    const otpRecord = db.prepare(
      "SELECT * FROM otp_codes WHERE phone = ? AND code_hash = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
    ).get(phone, otpHash);

    if (!otpRecord) {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP. Please request a new one.' });
    }

    // Mark OTP as used
    db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(otpRecord.id);

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      db.prepare('INSERT INTO users (phone, name, role) VALUES (?, ?, ?)').run(phone, name || '', 'customer');
      user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    } else if (name && !user.name) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
      user.name = name;
    }

    // Generate tokens
    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    // Store refresh token
    const refreshHash = hashValue(refreshToken);
    const refreshExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(user.id, refreshHash, refreshExpiry);

    res.json({
      success: true,
      message: 'Login successful.',
      data: {
        user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
        accessToken,
        refreshToken,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/refresh
 * Body: { refreshToken: string }
 */
router.post('/refresh', (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, error: 'Refresh token is required.' });
    }

    // Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid or expired refresh token.' });
    }

    // Check if token exists in DB
    const tokenHash = hashValue(refreshToken);
    const storedToken = db.prepare(
      "SELECT * FROM refresh_tokens WHERE user_id = ? AND token_hash = ? AND expires_at > datetime('now')"
    ).get(decoded.userId, tokenHash);

    if (!storedToken) {
      return res.status(401).json({ success: false, error: 'Refresh token revoked or expired.' });
    }

    // Issue new access token
    const user = db.prepare('SELECT id, phone, name, role FROM users WHERE id = ?').get(decoded.userId);
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found.' });
    }

    const newAccessToken = generateAccessToken(user.id);

    res.json({
      success: true,
      data: {
        accessToken: newAccessToken,
        user,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 * Body: { refreshToken: string }
 */
router.post('/logout', (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const tokenHash = hashValue(refreshToken);
      db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(tokenHash);
    }
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Requires authenticate middleware
 */
router.get('/me', authenticate, (req, res) => {
  res.json({
    success: true,
    data: req.user,
  });
});

export default router;
