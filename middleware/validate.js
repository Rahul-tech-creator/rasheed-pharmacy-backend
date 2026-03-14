import { body, param, query, validationResult } from 'express-validator';

// Middleware to check validation results
export const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.log('❌ Validation Failures:', JSON.stringify(errors.array(), null, 2));
    console.log('   Params:', req.params);
    console.log('   Body:', req.body);
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      error: errors.array()[0].msg, // Direct error string for easier frontend notification
      errors: errors.array().map(e => ({ field: e.path, message: e.msg }))
    });
  }
  next();
};

// Medicine validations
export const validateMedicine = [
  body('name')
    .trim()
    .notEmpty().withMessage('Medicine name is required')
    .isLength({ max: 200 }).withMessage('Name must be under 200 characters'),
  body('price')
    .isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('stock')
    .isInt({ min: 0 }).withMessage('Stock must be a non-negative integer'),
  body('category')
    .optional()
    .trim()
    .isLength({ max: 100 }).withMessage('Category must be under 100 characters'),
  body('expiry_date')
    .notEmpty().withMessage('Expiry date is required')
    .isISO8601().withMessage('Expiry date must be a valid date (YYYY-MM-DD)'),
  handleValidation
];

export const validateMedicineUpdate = [
  param('id').isUUID().withMessage('Invalid medicine ID'),
  body('name')
    .optional()
    .trim()
    .notEmpty().withMessage('Medicine name cannot be empty')
    .isLength({ max: 200 }).withMessage('Name must be under 200 characters'),
  body('price')
    .optional()
    .isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('stock')
    .optional()
    .isInt({ min: 0 }).withMessage('Stock must be a non-negative integer'),
  body('category')
    .optional()
    .trim()
    .isLength({ max: 100 }).withMessage('Category must be under 100 characters'),
  body('expiry_date')
    .optional()
    .isISO8601().withMessage('Expiry date must be a valid date (YYYY-MM-DD)'),
  handleValidation
];

export const validateSell = [
  param('id').isUUID().withMessage('Invalid medicine ID'),
  body('quantity')
    .optional()
    .isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  handleValidation
];

// Prescription validations
export const validatePrescription = [
  body('customer_name')
    .trim()
    .notEmpty().withMessage('Customer name is required')
    .isLength({ max: 100 }).withMessage('Name must be under 100 characters'),
  body('customer_phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^[\d\s+\-()]{7,15}$/).withMessage('Invalid phone number format'),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Notes must be under 500 characters'),
  handleValidation
];

export const validateStatusUpdate = [
  param('id').isUUID().withMessage('Invalid prescription ID'),
  body('status')
    .notEmpty().withMessage('Status is required')
    .isIn(['Received', 'Checking Medicines', 'Preparing Order', 'Ready for Pickup', 'Completed']).withMessage('Status must be a valid pipeline value'),
  body('expected_date')
    .optional()
    .isISO8601().withMessage('Expected date must be a valid date (YYYY-MM-DD)'),
  handleValidation
];

// Slot validations
export const validateSlot = [
  body('customer_name')
    .trim()
    .notEmpty().withMessage('Customer name is required')
    .isLength({ max: 100 }).withMessage('Name must be under 100 characters'),
  body('customer_phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^[\d\s+\-()]{7,15}$/).withMessage('Invalid phone number format'),
  body('pickup_date')
    .notEmpty().withMessage('Pickup date is required')
    .isISO8601().withMessage('Invalid date format'),
  body('pickup_time')
    .notEmpty().withMessage('Pickup time is required')
    .matches(/^\d{2}:\d{2}$/).withMessage('Time must be in HH:MM format'),
  body('prescription_id')
    .optional({ values: 'null' })
    .isUUID().withMessage('Invalid prescription ID'),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Notes must be under 500 characters'),
  handleValidation
];
