# Rasheed Pharmacy - Backend API

Secure API server for Rasheed Pharmacy, handling authentication, inventory, and prescriptions.

## Tech Stack
- Node.js & Express
- SQLite (better-sqlite3)
- JWT Authentication
- Multer (File Uploads)

## Setup instructions

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Environment Setup:**
   - Copy `.env.example` to `.env`
   - Fill in your `JWT_SECRET` and other placeholders.

3. **Database Migration:**
   ```bash
   npm run migrate
   ```

4. **Run Server:**
   ```bash
   npm run server
   ```

## API Endpoints
- `/api/auth` - Login, OTP Verify, Refresh
- `/api/medicines` - Inventory Management
- `/api/prescriptions` - Uploads & Orders
- `/api/slots` - Pickup Scheduling
