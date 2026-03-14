import jwt from 'jsonwebtoken';
import db from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'rasheed-pharmacy-jwt-secret-key-2026';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'rasheed-pharmacy-refresh-secret-key-2026';

export { JWT_SECRET, JWT_REFRESH_SECRET };

/**
 * Authenticate — verifies JWT from Authorization header.
 * Attaches req.user = { id, phone, name, role }
 */
export const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await db.query('SELECT id, phone_number, name, role FROM users WHERE id = $1', [decoded.userId]);
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found. Please log in again.' });
    }
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Session expired. Please refresh or log in again.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, error: 'Invalid token. Please log in again.' });
  }
};

/**
 * Optional authenticate — same as authenticate but doesn't fail if no token
 */
export const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await db.query('SELECT id, phone_number, name, role FROM users WHERE id = $1', [decoded.userId]);
    req.user = result.rows[0] || null;
  } catch {
    req.user = null;
  }
  next();
};

/**
 * Require owner role
 */
export const requireOwner = (req, res, next) => {
  if (!req.user || req.user.role !== 'owner') {
    return res.status(403).json({ success: false, error: 'Owner access required.' });
  }
  next();
};

/**
 * Require customer role
 */
export const requireCustomer = (req, res, next) => {
  if (!req.user || req.user.role !== 'customer') {
    return res.status(403).json({ success: false, error: 'Customer access required.' });
  }
  next();
};
