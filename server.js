require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const compression = require('compression');
const session = require('express-session');
const path = require('path');

// Notification services
const telegram = require('./services/telegram');
const email = require('./services/email');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Service prices map (server-side validation)
const SERVICES = {
    'Мъжко Подстригване': 25,
    'Оформяне на Брада': 15,
    'Пълен Пакет': 35,
    'Детско Подстригване': 20
};

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000'];

app.use(compression());

app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(null, true);
        }
    },
    credentials: true
}));
app.use(bodyParser.json());

// Trust proxy in production (Render, Railway, etc.)
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// Session middleware for admin authentication
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// Database Setup
const db = new sqlite3.Database('./appointments.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to the SQLite database.');
});

db.serialize(() => {
    // Appointments table
    db.run(`CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        time TEXT,
        service TEXT,
        price INTEGER DEFAULT 0,
        clientName TEXT,
        clientPhone TEXT,
        clientEmail TEXT,
        status TEXT DEFAULT 'pending',
        confirmationCode TEXT,
        reminderSent INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Telegram subscribers table
    db.run(`CREATE TABLE IF NOT EXISTS telegram_subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT UNIQUE,
        phone TEXT UNIQUE,
        name TEXT,
        subscribedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Blocked phones table
    db.run(`CREATE TABLE IF NOT EXISTS blocked_phones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE,
        reason TEXT,
        blockedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Performance indices
    db.run("CREATE INDEX IF NOT EXISTS idx_appt_date_status ON appointments(date, status)");
    db.run("CREATE INDEX IF NOT EXISTS idx_appt_phone ON appointments(clientPhone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_appt_code ON appointments(confirmationCode)");

    // Migrations for existing databases
    db.all("PRAGMA table_info(appointments)", (err, columns) => {
        if (err) {
            console.error("Schema check failed:", err);
            return;
        }

        const migrations = [
            { name: 'price', sql: "ALTER TABLE appointments ADD COLUMN price INTEGER DEFAULT 0" },
            { name: 'createdAt', sql: "ALTER TABLE appointments ADD COLUMN createdAt DATETIME DEFAULT CURRENT_TIMESTAMP" },
            { name: 'confirmationCode', sql: "ALTER TABLE appointments ADD COLUMN confirmationCode TEXT" },
            { name: 'reminderSent', sql: "ALTER TABLE appointments ADD COLUMN reminderSent INTEGER DEFAULT 0" },
            { name: 'clientEmail', sql: "ALTER TABLE appointments ADD COLUMN clientEmail TEXT" }
        ];

        migrations.forEach(migration => {
            const hasColumn = columns.some(col => col.name === migration.name);
            if (!hasColumn) {
                console.log(`Migrating database: Adding '${migration.name}' column...`);
                db.run(migration.sql);
            }
        });
    });

    // Initialize notification services after database is ready
    setTimeout(() => {
        telegram.initTelegram(db);
        email.initEmail(db);
        scheduler.initScheduler(db, telegram, email);
    }, 1000);
});

// Helper: Generate confirmation code
function generateConfirmationCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = 'HB-';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Helper: Generate slots for a day
// Break time: 13:00 - 15:00
const WORK_HOURS = [
    "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
    "15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30"
];

// Auth middleware for admin routes
function requireAuth(req, res, next) {
    // DEMO MODE: auth disabled
    return next();
}

// ============ PUBLIC API ============

// Health Check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        notifications: {
            telegram: telegram.isEnabled() ? 'enabled' : 'disabled',
            email: email.isEnabled() ? 'enabled' : 'disabled'
        }
    });
});

// API: Get Slots for Date
app.get('/api/slots', (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "Date required" });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
    }

    db.all("SELECT time, status FROM appointments WHERE date = ? AND status IN ('pending', 'confirmed')", [date], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const booked = {};
        rows.forEach(r => booked[r.time] = r.status);

        const slots = WORK_HOURS.map(time => ({
            time,
            status: booked[time] || 'free'
        }));

        res.json(slots);
    });
});

// API: Check Appointment Status (public - by confirmation code)
app.get('/api/status/:code', (req, res) => {
    const { code } = req.params;

    if (!code || code.length < 5) {
        return res.status(400).json({ error: "Invalid code" });
    }

    console.log(`Status check for code: ${code.toUpperCase()}`);

    db.get(
        "SELECT id, date, time, service, status, clientName FROM appointments WHERE confirmationCode = ?",
        [code.toUpperCase()],
        (err, row) => {
            if (err) return res.status(500).json({ error: "Database error" });
            if (!row) {
                console.log(`Status check: No appointment found for code ${code}`);
                return res.status(404).json({ error: "Appointment not found" });
            }

            console.log(`Status check: Found appointment ${row.id}, status: ${row.status}`);

            res.json({
                found: true,
                status: row.status,
                date: row.date,
                time: row.time,
                service: row.service,
                name: row.clientName
            });
        }
    );
});

// API: Book Appointment
app.post('/api/book', (req, res) => {
    const { date, time, service, clientName, clientPhone, clientEmail } = req.body;

    if (!date || !time || !clientName || !clientPhone || !service) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "Invalid date format" });
    }

    if (!WORK_HOURS.includes(time)) {
        return res.status(400).json({ error: "Invalid time slot" });
    }

    const validatedPrice = SERVICES[service];
    if (validatedPrice === undefined) {
        return res.status(400).json({ error: "Invalid service" });
    }

    const phoneRegex = /^(\+359|0)8[7-9][0-9]{7}$/;
    const cleanPhoneForValidation = clientPhone.replace(/[^0-9+]/g, '');
    if (!phoneRegex.test(cleanPhoneForValidation)) {
        return res.status(400).json({ error: "Invalid phone number format" });
    }

    // Validate email if provided
    if (clientEmail && !clientEmail.includes('@')) {
        return res.status(400).json({ error: "Invalid email format" });
    }

    let cleanPhone = clientPhone.replace(/[^0-9+]/g, '');
    if (cleanPhone.startsWith('+359')) cleanPhone = '0' + cleanPhone.slice(4);

    const sanitizedName = clientName.replace(/[<>]/g, '').trim().substring(0, 100);
    const sanitizedEmail = clientEmail ? clientEmail.trim().toLowerCase().substring(0, 100) : null;
    const confirmationCode = generateConfirmationCode();

    // Check if phone is blocked
    db.get("SELECT id FROM blocked_phones WHERE phone = ?", [cleanPhone], (err, blockedRow) => {
        if (err) return res.status(500).json({ error: "Database error" });
        if (blockedRow) {
            return res.status(403).json({ error: "blocked", message: "Този телефонен номер е блокиран. Не можете да запазите час." });
        }

    db.get("SELECT id FROM appointments WHERE date = ? AND time = ? AND status IN ('pending', 'confirmed')", [date, time], (err, row) => {
        if (err) return res.status(500).json({ error: "Database error" });
        if (row) return res.status(409).json({ error: "Slot already taken" });

        const stmt = db.prepare("INSERT INTO appointments (date, time, service, price, clientName, clientPhone, clientEmail, confirmationCode, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        stmt.run(date, time, service, validatedPrice, sanitizedName, cleanPhone, sanitizedEmail, confirmationCode, new Date().toISOString(), function(err) {
            if (err) return res.status(500).json({ error: "Failed to create appointment" });

            // Notify admin via Telegram
            if (telegram.isEnabled()) {
                telegram.sendAdminNewBooking({
                    clientName: sanitizedName,
                    clientPhone: cleanPhone,
                    date, time, service,
                    price: validatedPrice
                }).catch(e => console.error('Telegram admin notify failed:', e));
            }

            res.json({
                id: this.lastID,
                confirmationCode: confirmationCode,
                message: "Request sent"
            });
        });
    });
    }); // end blocked phone check
});

// ============ ADMIN AUTH ============

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;

    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';

    if (username === adminUser && password === adminPass) {
        req.session.isAdmin = true;
        res.json({ success: true, message: 'Login successful' });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ error: 'Logout failed' });
        res.json({ success: true, message: 'Logged out' });
    });
});

app.get('/api/admin/check-auth', (req, res) => {
    // DEMO MODE: always authenticated
    res.json({ authenticated: true });
});

// ============ PROTECTED ADMIN API ============

app.get('/api/admin/appointments', requireAuth, (req, res) => {
    const { search } = req.query;

    let query = "SELECT * FROM appointments";
    let params = [];

    if (search && search.trim()) {
        query += " WHERE clientName LIKE ? OR clientPhone LIKE ? OR confirmationCode LIKE ? OR clientEmail LIKE ? OR date LIKE ?";
        const searchTerm = `%${search.trim()}%`;
        params = [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm];
    }

    query += " ORDER BY createdAt DESC, id DESC LIMIT 100";

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/admin/stats', requireAuth, (req, res) => {
    const today = new Date().toISOString().split('T')[0];

    const query = `
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN status = 'confirmed' THEN price ELSE 0 END) as revenue,
            SUM(CASE WHEN date = ? AND status = 'pending' THEN 1 ELSE 0 END) as todayPending
        FROM appointments
    `;

    db.get(query, [today], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

// API: Admin Notifications (pending appointments only)
app.get('/api/admin/notifications', requireAuth, (req, res) => {
    const query = `
        SELECT id, clientName, clientPhone, service, date, time, status, createdAt
        FROM appointments
        WHERE status = 'pending'
        ORDER BY createdAt DESC
        LIMIT 20
    `;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// API: Admin Action (with notifications)
app.post('/api/admin/action', requireAuth, (req, res) => {
    const { id, action } = req.body;

    if (!id || !action) {
        return res.status(400).json({ error: "Missing id or action" });
    }

    if (!['confirm', 'reject'].includes(action)) {
        return res.status(400).json({ error: "Invalid action" });
    }

    const status = action === 'confirm' ? 'confirmed' : 'rejected';

    // First get the appointment details
    db.get("SELECT * FROM appointments WHERE id = ?", [id], (err, appointment) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!appointment) return res.status(404).json({ error: "Appointment not found" });

        // Update status
        db.run("UPDATE appointments SET status = ? WHERE id = ?", [status, id], async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: "Appointment not found" });

            // Send notifications if confirming
            let notifications = { telegram: false, email: false };

            console.log(`Action: ${action} for appointment ${id}, status changed to: ${status}`);

            if (action === 'confirm') {
                // Try Telegram
                if (telegram.isEnabled()) {
                    try {
                        notifications.telegram = await telegram.sendConfirmation(appointment.clientPhone, appointment);
                        console.log(`Telegram notification: ${notifications.telegram ? 'sent' : 'not sent (no subscriber)'}`);
                    } catch (e) {
                        console.error('Telegram notification failed:', e);
                    }
                }

                // Try Email to client
                if (email.isEnabled() && appointment.clientEmail) {
                    try {
                        notifications.email = await email.sendConfirmation(appointment.clientEmail, appointment);
                        console.log(`Email notification sent to client: ${appointment.clientEmail}`);
                    } catch (e) {
                        console.error('Email notification to client failed:', e);
                    }
                } else if (!appointment.clientEmail) {
                    console.log('Email notification to client skipped: no email address provided');
                }

            } else if (action === 'reject') {
                // Send rejection email to client
                if (email.isEnabled() && appointment.clientEmail) {
                    try {
                        notifications.email = await email.sendRejection(appointment.clientEmail, appointment);
                        console.log(`Email rejection sent to client: ${appointment.clientEmail}`);
                    } catch (e) {
                        console.error('Email rejection failed:', e);
                    }
                } else if (!appointment.clientEmail) {
                    console.log('Email rejection skipped: no email address provided');
                }
            }

            res.json({
                success: true,
                notifications: notifications
            });
        });
    });
});

app.post('/api/admin/edit', requireAuth, (req, res) => {
    const { id, clientName } = req.body;

    if (!id || !clientName) {
        return res.status(400).json({ error: "Missing id or clientName" });
    }

    const sanitizedName = clientName.replace(/[<>]/g, '').trim().substring(0, 100);

    db.run("UPDATE appointments SET clientName = ? WHERE id = ?", [sanitizedName, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Appointment not found" });
        res.json({ success: true });
    });
});

// API: Admin - Edit client name (by phone - updates all appointments)
app.post('/api/admin/edit-client', requireAuth, (req, res) => {
    const { phone, clientName } = req.body;

    if (!phone || !clientName) {
        return res.status(400).json({ error: "Missing phone or clientName" });
    }

    const sanitizedName = clientName.replace(/[<>]/g, '').trim().substring(0, 100);

    db.run("UPDATE appointments SET clientName = ? WHERE clientPhone = ?", [sanitizedName, phone], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "No appointments found for this phone" });
        res.json({ success: true, updated: this.changes });
    });
});

app.get('/api/admin/clients', requireAuth, (req, res) => {
    db.all("SELECT clientName, clientPhone, clientEmail, date, price FROM appointments WHERE status = 'confirmed'", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const clientsMap = {};

        rows.forEach(row => {
            if (!row.clientPhone) return;

            let cleanPhone = row.clientPhone.replace(/[^0-9+]/g, '');
            if (cleanPhone.startsWith('+359')) cleanPhone = '0' + cleanPhone.slice(4);

            if (!clientsMap[cleanPhone]) {
                clientsMap[cleanPhone] = {
                    name: row.clientName,
                    phone: cleanPhone,
                    email: row.clientEmail,
                    visits: 0,
                    totalSpent: 0,
                    lastVisit: row.date
                };
            }

            clientsMap[cleanPhone].visits += 1;
            clientsMap[cleanPhone].totalSpent += (row.price || 0);

            if (row.date > clientsMap[cleanPhone].lastVisit) {
                clientsMap[cleanPhone].name = row.clientName;
                clientsMap[cleanPhone].lastVisit = row.date;
                if (row.clientEmail) clientsMap[cleanPhone].email = row.clientEmail;
            }
        });

        const clientsArray = Object.values(clientsMap).sort((a, b) => b.visits - a.visits || b.totalSpent - a.totalSpent);
        res.json(clientsArray);
    });
});

// API: Admin - Get schedule for a specific date
app.get('/api/admin/schedule', requireAuth, (req, res) => {
    const { date } = req.query;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "Valid date required (YYYY-MM-DD)" });
    }

    db.all(
        "SELECT * FROM appointments WHERE date = ? AND status IN ('pending', 'confirmed') ORDER BY time ASC",
        [date],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// API: Admin - Get notification service status
app.get('/api/admin/notification-status', requireAuth, (req, res) => {
    db.get("SELECT COUNT(*) as count FROM telegram_subscribers", [], (err, row) => {
        res.json({
            telegram: {
                enabled: telegram.isEnabled(),
                subscribers: row ? row.count : 0
            },
            email: {
                enabled: email.isEnabled()
            }
        });
    });
});

// API: Admin - Block a phone number
app.post('/api/admin/block-phone', requireAuth, (req, res) => {
    const { phone, reason } = req.body;

    if (!phone) {
        return res.status(400).json({ error: "Missing phone number" });
    }

    let cleanPhone = phone.replace(/[^0-9+]/g, '');
    if (cleanPhone.startsWith('+359')) cleanPhone = '0' + cleanPhone.slice(4);

    db.run(
        "INSERT OR IGNORE INTO blocked_phones (phone, reason) VALUES (?, ?)",
        [cleanPhone, reason || null],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, blocked: cleanPhone });
        }
    );
});

// API: Admin - Unblock a phone number
app.post('/api/admin/unblock-phone', requireAuth, (req, res) => {
    const { phone } = req.body;

    if (!phone) {
        return res.status(400).json({ error: "Missing phone number" });
    }

    let cleanPhone = phone.replace(/[^0-9+]/g, '');
    if (cleanPhone.startsWith('+359')) cleanPhone = '0' + cleanPhone.slice(4);

    db.run("DELETE FROM blocked_phones WHERE phone = ?", [cleanPhone], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, unblocked: cleanPhone });
    });
});

// API: Admin - Get blocked phones list
app.get('/api/admin/blocked-phones', requireAuth, (req, res) => {
    db.all("SELECT * FROM blocked_phones ORDER BY blockedAt DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// API: Public - Check if phone is blocked
app.post('/api/check-phone', (req, res) => {
    const { phone } = req.body;

    if (!phone) {
        return res.status(400).json({ error: "Missing phone" });
    }

    let cleanPhone = phone.replace(/[^0-9+]/g, '');
    if (cleanPhone.startsWith('+359')) cleanPhone = '0' + cleanPhone.slice(4);

    db.get("SELECT id FROM blocked_phones WHERE phone = ?", [cleanPhone], (err, row) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ blocked: !!row });
    });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
});
