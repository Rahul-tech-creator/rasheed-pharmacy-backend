import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import authRouter from './routes/auth.js';
import medicinesRouter from './routes/medicines.js';
import prescriptionsRouter from './routes/prescriptions.js';
import slotsRouter from './routes/slots.js';
import { authenticate, requireOwner } from './middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/medicines', medicinesRouter);
app.use('/api/prescriptions', authenticate, prescriptionsRouter);
app.use('/api/slots', authenticate, slotsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'Rasheed Pharmacy API is running', timestamp: new Date().toISOString() });
});

// 404 handler
app.use('/api/{*splat}', (req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server Error:', err.message);

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: 'File too large. Maximum size is 10MB.' });
  }
  if (err.message?.includes('Only JPEG')) {
    return res.status(400).json({ success: false, error: err.message });
  }

  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

app.listen(PORT, () => {
  console.log(`\n🏥 Rasheed Pharmacy API Server`);
  console.log(`   Running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health\n`);
});
