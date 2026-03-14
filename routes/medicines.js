import { Router } from 'express';
import db from '../db.js';
import { validateMedicine, validateMedicineUpdate, validateSell } from '../middleware/validate.js';
import { authenticate, requireOwner } from '../middleware/auth.js';

const router = Router();

// GET /api/medicines — list all, with optional search & filters (PUBLIC)
router.get('/', async (req, res, next) => {
  try {
    const { search, category, low_stock, expiring_soon, sort_by, order } = req.query;

    let sql = 'SELECT * FROM medicines WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (search) {
      sql += ` AND name ILIKE $${paramIndex++}`;
      params.push(`%${search}%`);
    }

    if (category) {
      sql += ` AND category = $${paramIndex++}`;
      params.push(category);
    }

    if (low_stock === 'true') {
      sql += ' AND stock <= 10';
    }

    if (expiring_soon === 'true') {
      sql += " AND expiry_date::date <= (CURRENT_DATE + INTERVAL '3 months')";
    }

    // Sorting
    const allowedSorts = ['name', 'price', 'stock', 'expiry_date', 'created_at'];
    const sortCol = allowedSorts.includes(sort_by) ? sort_by : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sortCol} ${sortOrder}`;

    const medicinesRes = await db.query(sql, params);
    res.json({ success: true, data: medicinesRes.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/medicines/stats/summary — dashboard stats (PUBLIC for overview)
router.get('/stats/summary', async (req, res, next) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*) as count FROM medicines');
    const lowStockRes = await db.query('SELECT COUNT(*) as count FROM medicines WHERE stock <= 10');
    const outOfStockRes = await db.query('SELECT COUNT(*) as count FROM medicines WHERE stock = 0');
    const expiringSoonRes = await db.query("SELECT COUNT(*) as count FROM medicines WHERE expiry_date::date <= (CURRENT_DATE + INTERVAL '3 months')");
    const totalValueRes = await db.query('SELECT COALESCE(SUM(price * stock), 0) as value FROM medicines');

    res.json({
      success: true,
      data: {
        total: parseInt(totalRes.rows[0].count, 10),
        lowStock: parseInt(lowStockRes.rows[0].count, 10),
        outOfStock: parseInt(outOfStockRes.rows[0].count, 10),
        expiringSoon: parseInt(expiringSoonRes.rows[0].count, 10),
        totalValue: parseFloat(totalValueRes.rows[0].value)
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/medicines/:id — get single medicine (PUBLIC)
router.get('/:id', async (req, res, next) => {
  try {
    const medicineRes = await db.query('SELECT * FROM medicines WHERE id = $1', [req.params.id]);
    const medicine = medicineRes.rows[0];
    if (!medicine) {
      return res.status(404).json({ success: false, error: 'Medicine not found' });
    }
    res.json({ success: true, data: medicine });
  } catch (err) {
    next(err);
  }
});

// POST /api/medicines — add new medicine (OWNER ONLY)
router.post('/', authenticate, requireOwner, validateMedicine, async (req, res, next) => {
  try {
    const { name, price, stock, category, expiry_date } = req.body;
    const result = await db.query(
      'INSERT INTO medicines (name, price, stock, category, expiry_date) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, price, stock, category || 'General', expiry_date]
    );

    const newMedicineRes = await db.query('SELECT * FROM medicines WHERE id = $1', [result.rows[0].id]);
    res.status(201).json({ success: true, data: newMedicineRes.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/medicines/:id — update medicine (OWNER ONLY)
router.put('/:id', authenticate, requireOwner, validateMedicineUpdate, async (req, res, next) => {
  try {
    const existingRes = await db.query('SELECT * FROM medicines WHERE id = $1', [req.params.id]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Medicine not found' });
    }

    const { name, price, stock, category, expiry_date } = req.body;
    await db.query(`
      UPDATE medicines 
      SET name = COALESCE($1, name),
          price = COALESCE($2, price),
          stock = COALESCE($3, stock),
          category = COALESCE($4, category),
          expiry_date = COALESCE($5, expiry_date),
          updated_at = NOW()
      WHERE id = $6
    `, [
      name ?? null,
      price ?? null,
      stock ?? null,
      category ?? null,
      expiry_date ?? null,
      req.params.id
    ]);

    const updatedRes = await db.query('SELECT * FROM medicines WHERE id = $1', [req.params.id]);
    res.json({ success: true, data: updatedRes.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/medicines/:id/sell — reduce stock (OWNER ONLY)
router.patch('/:id/sell', authenticate, requireOwner, validateSell, async (req, res, next) => {
  try {
    const medicineRes = await db.query('SELECT * FROM medicines WHERE id = $1', [req.params.id]);
    const medicine = medicineRes.rows[0];
    if (!medicine) {
      return res.status(404).json({ success: false, error: 'Medicine not found' });
    }

    const quantity = parseInt(req.body.quantity, 10) || 1;
    if (medicine.stock < quantity) {
      return res.status(400).json({
        success: false,
        error: `Insufficient stock. Available: ${medicine.stock}, Requested: ${quantity}`
      });
    }

    await db.query(`
      UPDATE medicines 
      SET stock = stock - $1, updated_at = NOW()
      WHERE id = $2
    `, [quantity, req.params.id]);

    const updatedRes = await db.query('SELECT * FROM medicines WHERE id = $1', [req.params.id]);
    res.json({ success: true, data: updatedRes.rows[0], message: `Sold ${quantity} unit(s)` });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/medicines/:id (OWNER ONLY)
router.delete('/:id', authenticate, requireOwner, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM medicines WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Medicine not found' });
    }
    res.json({ success: true, message: 'Medicine deleted successfully' });
  } catch (err) {
    next(err);
  }
});

export default router;
