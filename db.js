import pool from './config/db.js';

// Initialization scripts
async function initDb() {
  try {
    console.log('🔄 Starting comprehensive database migration...');

    // Helper to run a step and log
    const runStep = async (name, query) => {
      try {
        await pool.query(query);
        console.log(`✅ ${name}`);
      } catch (e) {
        console.log(`⚠️ ${name} (might be already fixed):`, e.message);
      }
    };

    // --- USERS TABLE ---
    await runStep('Rename users.phone to users.phone_number', 
      'ALTER TABLE users RENAME COLUMN phone TO phone_number');
    await runStep('Add users.name', 
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255) NOT NULL DEFAULT \'\'');
    await runStep('Add users.role', 
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) NOT NULL DEFAULT \'customer\'');
    await runStep('Convert users.id to UUID', 
      'ALTER TABLE users ALTER COLUMN id SET DATA TYPE UUID USING gen_random_uuid()'); // Forced reset if needed

    // --- OTP_REQUESTS TABLE ---
    await runStep('Rename otp_requests.phone to phone_number', 
      'ALTER TABLE otp_requests RENAME COLUMN phone TO phone_number');
    await runStep('Add otp_requests.status', 
      'ALTER TABLE otp_requests ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT \'pending\'');
    await runStep('Add otp_requests.otp_code', 
      'ALTER TABLE otp_requests ADD COLUMN IF NOT EXISTS otp_code VARCHAR(255)');
    await runStep('Convert otp_requests.id to UUID', 
      'ALTER TABLE otp_requests ALTER COLUMN id SET DATA TYPE UUID USING gen_random_uuid()');

    // --- PRESCRIPTIONS TABLE ---
    await runStep('Add prescriptions.customer_name', 
      'ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)');
    await runStep('Add prescriptions.customer_phone', 
      'ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(255)');
    await runStep('Add prescriptions.file_path', 
      'ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS file_path VARCHAR(255)');
    await runStep('Add prescriptions.original_filename', 
      'ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS original_filename VARCHAR(255)');
    await runStep('Add prescriptions.expected_date', 
      'ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS expected_date VARCHAR(255)');
    await runStep('Add prescriptions.notes', 
      'ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS notes TEXT');
    await runStep('Add prescriptions.updated_at', 
      'ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

    // --- PICKUP_SLOTS TABLE ---
    await runStep('Add pickup_slots.customer_name', 
      'ALTER TABLE pickup_slots ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)');
    await runStep('Add pickup_slots.customer_phone', 
      'ALTER TABLE pickup_slots ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(255)');

    // --- REFRESH_TOKENS TABLE ---
    try {
      await pool.query(`
        DO $$
        DECLARE
          fkey_name text;
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'refresh_tokens') THEN
            SELECT constraint_name INTO fkey_name
            FROM information_schema.key_column_usage
            WHERE table_name = 'refresh_tokens' AND column_name = 'user_id' LIMIT 1;
            IF fkey_name IS NOT NULL THEN
              EXECUTE 'ALTER TABLE refresh_tokens DROP CONSTRAINT ' || fkey_name;
            END IF;
            ALTER TABLE refresh_tokens ALTER COLUMN user_id TYPE UUID USING user_id::UUID;
          END IF;
        END $$;
      `);
      console.log('✅ Fixed refresh_tokens user_id type');
    } catch (e) {
      console.log('⚠️ Refresh tokens migration skipped:', e.message);
    }

    // --- MEDICINES TABLE ---
    await runStep('Rename medicines.stock_quantity to stock', 
      'ALTER TABLE medicines RENAME COLUMN stock_quantity TO stock');
    await runStep('Add medicines.category', 
      'ALTER TABLE medicines ADD COLUMN IF NOT EXISTS category VARCHAR(255) DEFAULT \'General\'');
    await runStep('Add medicines.expiry_date', 
      'ALTER TABLE medicines ADD COLUMN IF NOT EXISTS expiry_date DATE');
    await runStep('Add medicines.price', 
      'ALTER TABLE medicines ADD COLUMN IF NOT EXISTS price REAL DEFAULT 0');
    await runStep('Add medicines.updated_at', 
      'ALTER TABLE medicines ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

    // --- CREATE/VERIFY TABLES ---
    const tableQueries = [
      `CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL DEFAULT '',
        role VARCHAR(50) NOT NULL DEFAULT 'customer' CHECK(role IN ('customer', 'owner')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS otp_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number VARCHAR(255) NOT NULL,
        otp_code VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS medicines (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        price REAL NOT NULL CHECK(price >= 0),
        stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
        category VARCHAR(255) DEFAULT 'General',
        expiry_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS prescriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        customer_name VARCHAR(255),
        customer_phone VARCHAR(255),
        file_path VARCHAR(255),
        original_filename VARCHAR(255),
        image_url TEXT,
        notes TEXT,
        status VARCHAR(50) DEFAULT 'Received',
        expected_date VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )`,
      `CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        prescription_id UUID NOT NULL,
        medicine_id UUID NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        price REAL NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE,
        FOREIGN KEY (medicine_id) REFERENCES medicines(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS pickup_slots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        customer_name VARCHAR(255),
        customer_phone VARCHAR(255),
        pickup_date DATE NOT NULL,
        pickup_time TIME NOT NULL,
        prescription_id UUID,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) ON DELETE SET NULL
      )`
    ];

    for (const q of tableQueries) {
      await pool.query(q);
    }
    console.log('✅ Final table structure verified');

    // Step 4: Seed owner
    const ownerPhones = ['9052277644', '9999999999'];
    for (const phone of ownerPhones) {
      const res = await pool.query('SELECT id, role FROM users WHERE phone_number = $1', [phone]);
      if (res.rows.length === 0) {
        await pool.query('INSERT INTO users (phone_number, name, role) VALUES ($1, $2, $3)', [phone, phone === '9052277644' ? 'Rahul (Owner)' : 'System Owner', 'owner']);
        console.log(`🔑 Owner account seeded: ${phone}`);
      } else if (res.rows[0].role !== 'owner') {
        await pool.query('UPDATE users SET role = \'owner\' WHERE id = $1', [res.rows[0].id]);
        console.log(`🆙 User promoted to Owner: ${phone}`);
      }
    }

    console.log('🚀 Database initialization complete!');
  } catch (err) {
    console.error("❌ Critical Database initialization error:", err.message);
  }
}

initDb();

export default pool;
