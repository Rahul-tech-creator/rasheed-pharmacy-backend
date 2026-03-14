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
router.post('/send-otp', otpLimiter, async (req, res, next) => {
  try {
    let { phone, name } = req.body;

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, error: 'Phone number is required.' });
    }

    // Normalize phone — keep only digits (e.g. 9052277644)
    phone = phone.replace(/\D/g, '');
    if (phone.length < 10 || phone.length > 15) {
      return res.status(400).json({ success: false, error: 'Invalid phone number. Must be 10-15 digits.' });
    }

    // Prepend 91 if it's a 10-digit Indian number for 2Factor
    const fullPhone = phone.length === 10 ? `91${phone}` : phone;

    // Clean up expired OTPs for this phone
    await db.query("DELETE FROM otp_requests WHERE phone_number = $1 OR expires_at < NOW()", [phone]);

    // Call 2Factor AUTOGEN API
    const apiKey = process.env.SMS_API_KEY;
    if (!apiKey) {
      throw new Error('SMS API key is not configured.');
    }
    
    // Use the full normalized phone (e.g. 919052277644)
    const authUrl = `https://2factor.in/API/V1/${apiKey}/SMS/${fullPhone}/AUTOGEN`;
    console.log(`📡 Sending OTP via 2Factor: ${authUrl.replace(apiKey, 'HIDDEN')}`);
    const response = await fetch(authUrl);
    const data = await response.json();
    
    if (data.Status !== 'Success') {
      console.error('2Factor API Error:', data);
      return res.status(500).json({ success: false, error: 'Failed to send OTP SMS.' });
    }
    
    const sessionId = data.Details;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    await db.query('INSERT INTO otp_requests (phone_number, otp_code, expires_at) VALUES ($1, $2, $3)', [phone, sessionId, expiresAt]);

    res.json({
      success: true,
      message: 'OTP sent successfully.'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/verify-otp
 * Body: { phone: string, otp: string, name?: string }
 */
router.post('/verify-otp', async (req, res, next) => {
  try {
    let { phone, otp, name } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, error: 'Phone and OTP are required.' });
    }

    phone = phone.replace(/\D/g, '');
    // Find valid OTP request session
    const otpRes = await db.query(
      "SELECT * FROM otp_requests WHERE phone_number = $1 AND status != 'verified' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
      [phone]
    );
    const otpRecord = otpRes.rows[0];

    if (!otpRecord) {
      return res.status(400).json({ success: false, error: 'OTP request not found or expired. Please request a new one.' });
    }

    const sessionId = otpRecord.otp_code;
    const apiKey = process.env.SMS_API_KEY;

    // Call 2Factor VERIFY API
    const verifyUrl = `https://2factor.in/API/V1/${apiKey}/SMS/VERIFY/${sessionId}/${otp}`;
    const response = await fetch(verifyUrl);
    const data = await response.json();

    if (data.Status !== 'Success') {
      return res.status(400).json({ success: false, error: 'Invalid OTP. Please try again.' });
    }

    // Mark OTP as verified
    await db.query("UPDATE otp_requests SET status = 'verified' WHERE id = $1", [otpRecord.id]);

    // Find or create user
    let userRes = await db.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
    let user = userRes.rows[0];
    if (!user) {
      await db.query('INSERT INTO users (phone_number, name, role) VALUES ($1, $2, $3)', [phone, name || '', 'customer']);
      userRes = await db.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
      user = userRes.rows[0];
    } else if (name && !user.name) {
      await db.query('UPDATE users SET name = $1 WHERE id = $2', [name, user.id]);
      user.name = name;
    }

    // Generate tokens
    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    // Store refresh token
    const refreshHash = hashValue(refreshToken);
    const refreshExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await db.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [user.id, refreshHash, refreshExpiry]);

    res.json({
      success: true,
      message: 'Login successful.',
      data: {
        user: { id: user.id, phone: user.phone_number, name: user.name, role: user.role },
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
router.post('/refresh', async (req, res, next) => {
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
    const storedRes = await db.query(
      "SELECT * FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2 AND expires_at > NOW()",
      [decoded.userId, tokenHash]
    );
    const storedToken = storedRes.rows[0];

    if (!storedToken) {
      return res.status(401).json({ success: false, error: 'Refresh token revoked or expired.' });
    }

    // Issue new access token
    const userRes = await db.query('SELECT id, phone_number, name, role FROM users WHERE id = $1', [decoded.userId]);
    const user = userRes.rows[0];
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
router.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const tokenHash = hashValue(refreshToken);
      await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
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
