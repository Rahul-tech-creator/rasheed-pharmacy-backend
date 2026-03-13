import { Router } from 'express';
import db from '../db.js';
import { validateSlot } from '../middleware/validate.js';

const router = Router();

// POST /api/slots — book a pickup slot
router.post('/', validateSlot, (req, res, next) => {
  try {
    const { customer_name, customer_phone, pickup_date, pickup_time, prescription_id, notes } = req.body;
    const userId = req.user?.id || null;

    // Check if slot is already taken
    const existing = db.prepare(
      'SELECT * FROM pickup_slots WHERE pickup_date = ? AND pickup_time = ?'
    ).get(pickup_date, pickup_time);

    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'This time slot is already booked. Please choose a different time.'
      });
    }

    // Validate prescription_id if provided
    if (prescription_id) {
      const prescription = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(prescription_id);
      if (!prescription) {
        return res.status(400).json({ success: false, error: 'Linked prescription not found' });
      }
    }

    const result = db.prepare(
      'INSERT INTO pickup_slots (user_id, customer_name, customer_phone, pickup_date, pickup_time, prescription_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, customer_name, customer_phone, pickup_date, pickup_time, prescription_id || null, notes || null);

    const slot = db.prepare('SELECT * FROM pickup_slots WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: slot });
  } catch (err) {
    next(err);
  }
});

// GET /api/slots — list slots
// Customers see only their own; owners see all
router.get('/', (req, res, next) => {
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

    // Customers can only see their own slots
    if (req.user && req.user.role === 'customer') {
      sql += ' AND (pickup_slots.user_id = ? OR pickup_slots.customer_phone = ?)';
      params.push(req.user.id, req.user.phone);
    }

    if (date) {
      sql += ' AND pickup_slots.pickup_date = ?';
      params.push(date);
    }

    if (phone && req.user?.role === 'owner') {
      sql += ' AND pickup_slots.customer_phone LIKE ?';
      params.push(`%${phone}%`);
    }

    sql += ' ORDER BY pickup_slots.pickup_date ASC, pickup_slots.pickup_time ASC';

    const slots = db.prepare(sql).all(...params);

    // Attach items for slots linked to an order
    const stmtItems = db.prepare('SELECT oi.*, m.name as medicine_name FROM order_items oi JOIN medicines m ON oi.medicine_id = m.id WHERE oi.prescription_id = ?');
    for (const slot of slots) {
      if (slot.prescription_id) {
        slot.items = stmtItems.all(slot.prescription_id);
      }
    }

    res.json({ success: true, data: slots });
  } catch (err) {
    next(err);
  }
});

// GET /api/slots/booked — get booked time slots for a specific date (public for availability check)
router.get('/booked', (req, res, next) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }

    const booked = db.prepare(
      'SELECT pickup_time FROM pickup_slots WHERE pickup_date = ?'
    ).all(date);

    res.json({ success: true, data: booked.map(s => s.pickup_time) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/slots/:id
router.delete('/:id', (req, res, next) => {
  try {
    // Customers can only delete their own
    if (req.user?.role === 'customer') {
      const slot = db.prepare('SELECT * FROM pickup_slots WHERE id = ?').get(req.params.id);
      if (slot && slot.user_id !== req.user.id && slot.customer_phone !== req.user.phone) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }

    const result = db.prepare('DELETE FROM pickup_slots WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Slot not found' });
    }
    res.json({ success: true, message: 'Slot cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

export default router;
