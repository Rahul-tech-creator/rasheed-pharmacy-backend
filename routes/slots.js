import { Router } from 'express';
import db from '../db.js';
import { validateSlot } from '../middleware/validate.js';

const router = Router();

// POST /api/slots — book a pickup slot
router.post('/', validateSlot, async (req, res, next) => {
  try {
    const { customer_name, customer_phone, pickup_date, pickup_time, prescription_id, notes } = req.body;
    const userId = req.user?.id || null;

    // Check if slot is already taken
    const existingRes = await db.query(
      'SELECT * FROM pickup_slots WHERE pickup_date = $1 AND pickup_time = $2',
      [pickup_date, pickup_time]
    );
    const existing = existingRes.rows[0];

    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'This time slot is already booked. Please choose a different time.'
      });
    }

    // Validate prescription_id if provided
    if (prescription_id) {
      const pRes = await db.query('SELECT * FROM prescriptions WHERE id = $1', [prescription_id]);
      if (pRes.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Linked prescription not found' });
      }
    }

    const result = await db.query(
      'INSERT INTO pickup_slots (user_id, customer_name, customer_phone, pickup_date, pickup_time, prescription_id, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [userId, customer_name, customer_phone, pickup_date, pickup_time, prescription_id || null, notes || null]
    );

    const slotRes = await db.query('SELECT * FROM pickup_slots WHERE id = $1', [result.rows[0].id]);
    res.status(201).json({ success: true, data: slotRes.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/slots — list slots
// Customers see only their own; owners see all
router.get('/', async (req, res, next) => {
  try {
    const { date, phone } = req.query;
    let sql = `
      SELECT pickup_slots.*, 
             prescriptions.status as prescription_status,
             prescriptions.customer_name as prescription_customer
      FROM pickup_slots 
      LEFT JOIN prescriptions ON pickup_slots.prescription_id = prescriptions.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    // Customers can only see their own slots
    if (req.user && req.user.role === 'customer') {
      sql += ` AND (pickup_slots.user_id = $${paramIndex} OR pickup_slots.customer_phone = $${paramIndex + 1})`;
      params.push(req.user.id, req.user.phone);
      paramIndex += 2;
    }

    if (date) {
      sql += ` AND pickup_slots.pickup_date = $${paramIndex++}`;
      params.push(date);
    }

    if (phone && req.user?.role === 'owner') {
      sql += ` AND pickup_slots.customer_phone ILIKE $${paramIndex++}`;
      params.push(`%${phone}%`);
    }

    sql += ' ORDER BY pickup_slots.pickup_date ASC, pickup_slots.pickup_time ASC';

    const slotsRes = await db.query(sql, params);
    const slots = slotsRes.rows;

    // Attach items for slots linked to an order
    for (const slot of slots) {
      if (slot.prescription_id) {
        const itemsRes = await db.query('SELECT oi.*, m.name as medicine_name FROM order_items oi JOIN medicines m ON oi.medicine_id = m.id WHERE oi.prescription_id = $1', [slot.prescription_id]);
        slot.items = itemsRes.rows;
      }
    }

    res.json({ success: true, data: slots });
  } catch (err) {
    next(err);
  }
});

// GET /api/slots/booked — get booked time slots for a specific date (public for availability check)
router.get('/booked', async (req, res, next) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }

    const bookedRes = await db.query(
      'SELECT pickup_time FROM pickup_slots WHERE pickup_date = $1',
      [date]
    );

    res.json({ success: true, data: bookedRes.rows.map(s => s.pickup_time) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/slots/:id
router.delete('/:id', async (req, res, next) => {
  try {
    // Customers can only delete their own
    if (req.user?.role === 'customer') {
      const slotRes = await db.query('SELECT * FROM pickup_slots WHERE id = $1', [req.params.id]);
      const slot = slotRes.rows[0];
      if (slot && slot.user_id !== req.user.id && slot.customer_phone !== req.user.phone) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }

    const result = await db.query('DELETE FROM pickup_slots WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Slot not found' });
    }
    res.json({ success: true, message: 'Slot cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

export default router;
