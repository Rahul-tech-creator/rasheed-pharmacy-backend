import Database from 'better-sqlite3';

try {
  const db = new Database('./server/pharmacy.db');
  
  // Check if expected_date column exists
  const tableInfo = db.prepare("PRAGMA table_info(prescriptions)").all();
  const hasExpectedDate = tableInfo.some(col => col.name === 'expected_date');

  db.pragma('foreign_keys=off');
  
  if (!hasExpectedDate) {
    db.transaction(() => {
      db.exec(`ALTER TABLE prescriptions RENAME TO _prescriptions_old`);
      db.exec(`
        CREATE TABLE prescriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_name TEXT NOT NULL,
          customer_phone TEXT NOT NULL,
          file_path TEXT,
          original_filename TEXT,
          notes TEXT,
          status TEXT DEFAULT 'Received',
          expected_date TEXT,
          created_at TEXT DEFAULT (datetime('now', 'localtime')),
          updated_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
      `);
      db.exec(`
        INSERT INTO prescriptions (id, customer_name, customer_phone, file_path, original_filename, notes, status, created_at, updated_at)
        SELECT id, customer_name, customer_phone, file_path, original_filename, notes, status, created_at, updated_at FROM _prescriptions_old
      `);
      db.exec(`DROP TABLE _prescriptions_old`);
    })();
    console.log("Prescriptions table migrated successfully to remove CHECK constraint and add expected_date.");
  } else {
    console.log("Prescriptions table already migrated.");
  }

  // Create order_items
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prescription_id INTEGER NOT NULL,
      medicine_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      price REAL NOT NULL,
      FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE,
      FOREIGN KEY (medicine_id) REFERENCES medicines(id) ON DELETE RESTRICT
    )
  `);
  console.log("order_items table created/verified.");

  db.pragma('foreign_keys=on');
  db.close();
} catch (err) {
  console.error("Migration error:", err);
}
