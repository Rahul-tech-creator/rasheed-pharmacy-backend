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
router.post('/', upload.single('prescription_file'), validatePrescription, async (req, res, next) => {
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

    const client = await db.connect();
    let prescriptionId;
    try {
      await client.query('BEGIN');
      
      // 1. Verify stock for all items
      for (const item of parsedItems) {
        const medRes = await client.query('SELECT id, name, price, stock FROM medicines WHERE id = $1 FOR UPDATE', [item.medicine_id]);
        const med = medRes.rows[0];
        if (!med) {
          throw new Error(`Medicine ID ${item.medicine_id} not found`);
        }
        if (med.stock < item.quantity) {
          throw new Error(`Only ${med.stock} units of ${med.name} are available. You can place an order for up to ${med.stock}.`);
        }
        item.price = med.price; // store historical price
      }

      // 2. Insert order
      const orderRes = await client.query(
        'INSERT INTO prescriptions (user_id, customer_name, customer_phone, file_path, original_filename, notes, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [userId, customer_name, customer_phone, filePath, originalFilename, notes || null, parsedItems.length > 0 ? 'Checking Medicines' : 'Received']
      );
      prescriptionId = orderRes.rows[0].id;

      // 3. Insert items and reduce stock
      for (const item of parsedItems) {
        await client.query('INSERT INTO order_items (prescription_id, medicine_id, quantity, price) VALUES ($1, $2, $3, $4)', [prescriptionId, item.medicine_id, item.quantity, item.price]);
        await client.query("UPDATE medicines SET stock = stock - $1, updated_at = NOW() WHERE id = $2", [item.quantity, item.medicine_id]);
      }
      
      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: txError.message });
    } finally {
      client.release();
    }

    const prescriptionRes = await db.query('SELECT * FROM prescriptions WHERE id = $1', [prescriptionId]);
    const orderItemsRes = await db.query('SELECT oi.*, m.name as medicine_name FROM order_items oi JOIN medicines m ON oi.medicine_id = m.id WHERE oi.prescription_id = $1', [prescriptionId]);
    res.status(201).json({ success: true, data: { ...prescriptionRes.rows[0], items: orderItemsRes.rows } });
  } catch (err) {
    next(err);
  }
});

// GET /api/prescriptions — list prescriptions
// Customers see only their own; owners see all
router.get('/', async (req, res, next) => {
  try {
    const { status, phone } = req.query;
    let sql = 'SELECT * FROM prescriptions WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    // Customers can only see their own prescriptions
    if (req.user && req.user.role === 'customer') {
      sql += ` AND (user_id = $${paramIndex} OR customer_phone = $${paramIndex + 1})`;
      params.push(req.user.id, req.user.phone);
      paramIndex += 2;
    }

    if (status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(status);
    }

    if (phone && req.user?.role === 'owner') {
      sql += ` AND customer_phone ILIKE $${paramIndex++}`;
      params.push(`%${phone}%`);
    }

    sql += ' ORDER BY created_at DESC';

    const prescriptionsRes = await db.query(sql, params);
    const prescriptions = prescriptionsRes.rows;
    
    // Attach order items
    // Better handled in a single join query, but rewriting loops for direct migration
    for (const rx of prescriptions) {
      const itemsRes = await db.query('SELECT oi.*, m.name as medicine_name FROM order_items oi JOIN medicines m ON oi.medicine_id = m.id WHERE oi.prescription_id = $1', [rx.id]);
      rx.items = itemsRes.rows;
    }

    res.json({ success: true, data: prescriptions });
  } catch (err) {
    next(err);
  }
});

// GET /api/prescriptions/:id
router.get('/:id', async (req, res, next) => {
  try {
    const pRes = await db.query('SELECT * FROM prescriptions WHERE id = $1', [req.params.id]);
    const prescription = pRes.rows[0];
    if (!prescription) {
      return res.status(404).json({ success: false, error: 'Prescription/Order not found' });
    }

    // Customers can only view their own
    if (req.user?.role === 'customer' && prescription.user_id !== req.user.id && prescription.customer_phone !== req.user.phone) {
      return res.status(403).json({ success: false, error: 'Access denied.' });
    }

    const itemsRes = await db.query('SELECT oi.*, m.name as medicine_name FROM order_items oi JOIN medicines m ON oi.medicine_id = m.id WHERE oi.prescription_id = $1', [prescription.id]);
    prescription.items = itemsRes.rows;
    res.json({ success: true, data: prescription });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/prescriptions/:id/status — update prescription status (OWNER ONLY)
router.patch('/:id/status', requireOwner, validateStatusUpdate, async (req, res, next) => {
  try {
    const { status, expected_date } = req.body;
    const existingRes = await db.query('SELECT * FROM prescriptions WHERE id = $1', [req.params.id]);
    const existing = existingRes.rows[0];

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

    await db.query(`
      UPDATE prescriptions 
      SET status = $1, 
          expected_date = COALESCE($2, expected_date),
          updated_at = NOW()
      WHERE id = $3
    `, [status, expected_date || null, req.params.id]);

    const updatedRes = await db.query('SELECT * FROM prescriptions WHERE id = $1', [req.params.id]);
    const updated = updatedRes.rows[0];
    const itemsRes = await db.query('SELECT oi.*, m.name as medicine_name FROM order_items oi JOIN medicines m ON oi.medicine_id = m.id WHERE oi.prescription_id = $1', [updated.id]);
    updated.items = itemsRes.rows;
    
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/prescriptions/:id (OWNER ONLY)
router.delete('/:id', requireOwner, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM prescriptions WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Prescription not found' });
    }
    res.json({ success: true, message: 'Prescription deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
