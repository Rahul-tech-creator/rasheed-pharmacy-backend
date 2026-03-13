import { Router } from 'express';
import db from '../db.js';
import { validateMedicine, validateMedicineUpdate, validateSell } from '../middleware/validate.js';
import { authenticate, requireOwner } from '../middleware/auth.js';

const router = Router();

// GET /api/medicines — list all, with optional search & filters (PUBLIC)
router.get('/', (req, res, next) => {
  try {
    const { search, category, low_stock, expiring_soon, sort_by, order } = req.query;

    let sql = 'SELECT * FROM medicines WHERE 1=1';
    const params = [];

    if (search) {
      sql += ' AND name LIKE ?';
      params.push(`%${search}%`);
    }

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }

    if (low_stock === 'true') {
      sql += ' AND stock <= 10';
    }

    if (expiring_soon === 'true') {
      sql += " AND expiry_date <= date('now', '+3 months')";
    }

    // Sorting
    const allowedSorts = ['name', 'price', 'stock', 'expiry_date', 'created_at'];
    const sortCol = allowedSorts.includes(sort_by) ? sort_by : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sortCol} ${sortOrder}`;

    const medicines = db.prepare(sql).all(...params);
    res.json({ success: true, data: medicines });
  } catch (err) {
    next(err);
  }
});

// GET /api/medicines/stats/summary — dashboard stats (PUBLIC for overview)
router.get('/stats/summary', (req, res, next) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as count FROM medicines').get();
    const lowStock = db.prepare('SELECT COUNT(*) as count FROM medicines WHERE stock <= 10').get();
    const outOfStock = db.prepare('SELECT COUNT(*) as count FROM medicines WHERE stock = 0').get();
    const expiringSoon = db.prepare("SELECT COUNT(*) as count FROM medicines WHERE expiry_date <= date('now', '+3 months')").get();
    const totalValue = db.prepare('SELECT COALESCE(SUM(price * stock), 0) as value FROM medicines').get();

    res.json({
      success: true,
      data: {
        total: total.count,
        lowStock: lowStock.count,
        outOfStock: outOfStock.count,
        expiringSoon: expiringSoon.count,
        totalValue: totalValue.value
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/medicines/:id — get single medicine (PUBLIC)
router.get('/:id', (req, res, next) => {
  try {
    const medicine = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
    if (!medicine) {
      return res.status(404).json({ success: false, error: 'Medicine not found' });
    }
    res.json({ success: true, data: medicine });
  } catch (err) {
    next(err);
  }
});

// POST /api/medicines — add new medicine (OWNER ONLY)
router.post('/', authenticate, requireOwner, validateMedicine, (req, res, next) => {
  try {
    const { name, price, stock, category, expiry_date } = req.body;
    const result = db.prepare(
      'INSERT INTO medicines (name, price, stock, category, expiry_date) VALUES (?, ?, ?, ?, ?)'
    ).run(name, price, stock, category || 'General', expiry_date);

    const newMedicine = db.prepare('SELECT * FROM medicines WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: newMedicine });
  } catch (err) {
    next(err);
  }
});

// PUT /api/medicines/:id — update medicine (OWNER ONLY)
router.put('/:id', authenticate, requireOwner, validateMedicineUpdate, (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Medicine not found' });
    }

    const { name, price, stock, category, expiry_date } = req.body;
    db.prepare(`
      UPDATE medicines 
      SET name = COALESCE(?, name),
          price = COALESCE(?, price),
          stock = COALESCE(?, stock),
          category = COALESCE(?, category),
          expiry_date = COALESCE(?, expiry_date),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? null,
      price ?? null,
      stock ?? null,
      category ?? null,
      expiry_date ?? null,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/medicines/:id/sell — reduce stock (OWNER ONLY)
router.patch('/:id/sell', authenticate, requireOwner, validateSell, (req, res, next) => {
  try {
    const medicine = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
    if (!medicine) {
      return res.status(404).json({ success: false, error: 'Medicine not found' });
    }

    const quantity = req.body.quantity || 1;
    if (medicine.stock < quantity) {
      return res.status(400).json({
        success: false,
        error: `Insufficient stock. Available: ${medicine.stock}, Requested: ${quantity}`
      });
    }

    db.prepare(`
      UPDATE medicines 
      SET stock = stock - ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(quantity, req.params.id);

    const updated = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: updated, message: `Sold ${quantity} unit(s)` });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/medicines/:id (OWNER ONLY)
router.delete('/:id', authenticate, requireOwner, (req, res, next) => {
  try {
    const result = db.prepare('DELETE FROM medicines WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Medicine not found' });
    }
    res.json({ success: true, message: 'Medicine deleted successfully' });
  } catch (err) {
    next(err);
  }
});


export default router;
