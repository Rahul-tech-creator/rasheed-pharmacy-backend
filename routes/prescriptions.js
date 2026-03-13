import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { validatePrescription, validateStatusUpdate } from '../middleware/validate.js';
import { requireOwner } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `prescription-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, WebP and PDF files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// POST /api/prescriptions — upload new prescription or create medicine order
router.post('/', upload.single('prescription_file'), validatePrescription, (req, res, next) => {
  try {
    const { customer_name, customer_phone, notes, items } = req.body;
    const userId = req.user?.id || null;
    const filePath = req.file ? req.file.filename : null;
    const originalFilename = req.file ? req.file.originalname : null;

    let parsedItems = [];
    if (items) {
      try {
        parsedItems = JSON.parse(items);
      } catch(e) {
        return res.status(400).json({ success: false, error: 'Invalid items format' });
      }
    }

    let result;
    const createOrder = db.transaction(() => {
      // 1. Verify stock for all items
      for (const item of parsedItems) {
        const med = db.prepare('SELECT id, name, price, stock FROM medicines WHERE id = ?').get(item.medicine_id);
        if (!med) {
          throw new Error(`Medicine ID ${item.medicine_id} not found`);
        }
        if (med.stock < item.quantity) {
          throw new Error(`Only ${med.stock} units of ${med.name} are available. You can place an order for up to ${med.stock}.`);
        }
        item.price = med.price; // store historical price
      }

      // 2. Insert order
      result = db.prepare(
        'INSERT INTO prescriptions (user_id, customer_name, customer_phone, file_path, original_filename, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(userId, customer_name, customer_phone, filePath, originalFilename, notes || null, parsedItems.length > 0 ? 'Checking Medicines' : 'Received');

      // 3. Insert items and reduce stock
      const insertItem = db.prepare('INSERT INTO order_items (prescription_id, medicine_id, quantity, price) VALUES (?, ?, ?, ?)');
      const reduceStock = db.prepare("UPDATE medicines SET stock = stock - ?, updated_at = datetime('now') WHERE id = ?");
      
      for (const item of parsedItems) {
        insertItem.run(result.lastInsertRowid, item.medicine_id, item.quantity, item.price);
        reduceStock.run(item.quantity, item.medicine_id);
      }
    });

    try {
      createOrder();
    } catch (txError) {
      return res.status(400).json({ success: false, error: txError.message });
    }

    const prescription = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(result.lastInsertRowid);
    const orderItems = db.prepare('SELECT oi.*, m.name as medicine_name FROM order_items oi JOIN medicines m ON oi.medicine_id = m.id WHERE oi.prescription_id = ?').all(prescription.id);
    res.status(201).json({ success: true, data: { ...prescription, items: orderItems } });
  } catch (err) {
    next(err);
  }
});

// GET /api/prescriptions — list prescriptions
// Customers see only their own; owners see all
router.get('/', (req, res, next) => {
  try {
    const { status, phone } = req.query;
    let sql = 'SELECT * FROM prescriptions WHERE 1=1';
    const params = [];

    // Customers can only see their own prescriptions
    if (req.user && req.user.role === 'customer') {
      sql += ' AND (user_id = ? OR customer_phone = ?)';
      params.push(req.user.id, req.user.phone);
    }

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (phone && req.user?.role === 'owner') {
      sql += ' AND customer_phone LIKE ?';
      params.push(`%${phone}%`);
    }

    sql += ' ORDER BY created_at DESC';

    const prescriptions = db.prepare(sql).all(...params);
    
    // Attach order items
    const stmtItems = db.prepare('SELECT oi.*, m.name as medicine_name FROM order_items oi JOIN medicines m ON oi.medicine_id = m.id WHERE oi.prescription_id = ?');
    for (const rx of prescriptions) {
      rx.items = stmtItems.all(rx.id);
    }

    res.json({ success: true, data: prescriptions });
  } catch (err) {
    next(err);
  }
});

// GET /api/prescriptions/:id
router.get('/:id', (req, res, next) => {
  try {
    const prescription = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(req.params.id);
    if (!prescription) {
      return res.status(404).json({ success: false, error: 'Prescription/Order not found' });
    }

    // Customers can only view their own
    if (req.user?.role === 'customer' && prescription.user_id !== req.user.id && prescription.customer_phone !== req.user.phone) {
      return res.status(403).json({ success: false, error: 'Access denied.' });
    }

    prescription.items = db.prepare('SELECT oi.*, m.name as medicine_name FROM order_items oi JOIN medicines m ON oi.medicine_id = m.id WHERE oi.prescription_id = ?').all(prescription.id);
    res.json({ success: true, data: prescription });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/prescriptions/:id/status — update prescription status (OWNER ONLY)
router.patch('/:id/status', requireOwner, validateStatusUpdate, (req, res, next) => {
  try {
    const { status, expected_date } = req.body;
    const existing = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(req.params.id);

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Prescription/Order not found' });
    }

    // Validate status progression
    const validTransitions = {
      'Received': ['Checking Medicines'],
      'Checking Medicines': ['Preparing Order'],
      'Preparing Order': ['Ready for Pickup'],
      'Ready for Pickup': ['Completed'],
      'Completed': []
    };

    if (existing.status !== status && !validTransitions[existing.status]?.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot transition from "${existing.status}" to "${status}". Valid next: ${validTransitions[existing.status]?.join(', ') || 'none'}`
      });
    }

    db.prepare(`
      UPDATE prescriptions 
      SET status = ?, 
          expected_date = COALESCE(?, expected_date),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(status, expected_date || null, req.params.id);

    const updated = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(req.params.id);
    updated.items = db.prepare('SELECT oi.*, m.name as medicine_name FROM order_items oi JOIN medicines m ON oi.medicine_id = m.id WHERE oi.prescription_id = ?').all(updated.id);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/prescriptions/:id (OWNER ONLY)
router.delete('/:id', requireOwner, (req, res, next) => {
  try {
    const result = db.prepare('DELETE FROM prescriptions WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Prescription not found' });
    }
    res.json({ success: true, message: 'Prescription deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
