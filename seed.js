const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'appointments.db');
const db = new sqlite3.Database(DB_PATH);

function generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = 'HB-';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function randomDate(startDays, endDays) {
    const now = new Date();
    const offset = startDays + Math.floor(Math.random() * (endDays - startDays));
    const d = new Date(now.getTime() + offset * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WORK_HOURS = [
    "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
    "15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30"
];

const SERVICES = [
    { name: "Мъжко Подстригване", price: 25 },
    { name: "Оформяне на Брада", price: 15 },
    { name: "Пълен Пакет", price: 35 },
    { name: "Детско Подстригване", price: 20 }
];

// Realistic Bulgarian clients
const CLIENTS = [
    { name: "Георги Иванов", phone: "0887123456", email: "georgi.ivanov@gmail.com" },
    { name: "Димитър Петров", phone: "0898234567", email: "d.petrov@abv.bg" },
    { name: "Иван Николов", phone: "0879345678", email: "ivan.nikolov@gmail.com" },
    { name: "Стефан Тодоров", phone: "0887456789", email: "stefan.t@yahoo.com" },
    { name: "Петър Георгиев", phone: "0898567890", email: null },
    { name: "Николай Димитров", phone: "0879678901", email: "n.dimitrov@gmail.com" },
    { name: "Александър Стоянов", phone: "0887789012", email: "alex.stoyanov@abv.bg" },
    { name: "Красимир Колев", phone: "0898890123", email: "krasikralevv@gmail.com" },
    { name: "Тодор Марков", phone: "0879901234", email: null },
    { name: "Мартин Йорданов", phone: "0887012345", email: "martin.y@gmail.com" },
    { name: "Христо Василев", phone: "0898112233", email: "hristo.v@abv.bg" },
    { name: "Калоян Ангелов", phone: "0879223344", email: null },
    { name: "Борис Павлов", phone: "0887334455", email: "boris.p@gmail.com" },
    { name: "Емил Костов", phone: "0898445566", email: "emil.kostov@yahoo.com" },
    { name: "Пламен Атанасов", phone: "0879556677", email: null },
    { name: "Радослав Христов", phone: "0887667788", email: "rado.hristov@gmail.com" },
    { name: "Владимир Цветков", phone: "0898778899", email: null },
    { name: "Деян Методиев", phone: "0879889900", email: "deyan.m@abv.bg" },
    { name: "Ангел Симеонов", phone: "0887990011", email: "angel.s@gmail.com" },
    { name: "Здравко Борисов", phone: "0898101112", email: null },
    { name: "Любомир Кирилов", phone: "0879212223", email: "lubo.k@gmail.com" },
    { name: "Момчил Генчев", phone: "0887323334", email: null },
    { name: "Даниел Стаменов", phone: "0898434445", email: "daniel.s@yahoo.com" },
    { name: "Веселин Златев", phone: "0879545556", email: "veselin.z@gmail.com" },
    { name: "Асен Крумов", phone: "0887656667", email: null },
    { name: "Янко Добрев", phone: "0898767778", email: "yanko.d@abv.bg" },
    { name: "Росен Миланов", phone: "0879878889", email: null },
    { name: "Тихомир Величков", phone: "0887989990", email: "tihomir.v@gmail.com" },
    { name: "Светослав Найденов", phone: "0898191011", email: null },
    { name: "Милен Захариев", phone: "0879292021", email: "milen.z@gmail.com" }
];

// How many visits each client gets (varied distribution)
const VISIT_COUNTS = [
    8, 7, 6, 6, 5, 5, 4, 4, 4, 3,
    3, 3, 3, 2, 2, 2, 2, 2, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1
];

db.serialize(() => {
    // Create tables
    db.run(`CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        time TEXT,
        service TEXT,
        price REAL,
        clientName TEXT,
        clientPhone TEXT,
        clientEmail TEXT,
        confirmationCode TEXT,
        status TEXT DEFAULT 'pending',
        reminderSent INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS telegram_subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT UNIQUE,
        phone TEXT UNIQUE,
        name TEXT,
        subscribedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS blocked_phones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE,
        reason TEXT,
        blockedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const stmt = db.prepare(`INSERT INTO appointments
        (date, time, service, price, clientName, clientPhone, clientEmail, confirmationCode, status, reminderSent, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);

    let totalAppointments = 0;

    CLIENTS.forEach((client, index) => {
        const visits = VISIT_COUNTS[index];

        for (let v = 0; v < visits; v++) {
            // Past appointments (confirmed or rejected)
            const daysBack = -(v * 7 + Math.floor(Math.random() * 5) + 1);
            const date = randomDate(daysBack - 2, daysBack);
            const time = WORK_HOURS[Math.floor(Math.random() * WORK_HOURS.length)];
            const service = SERVICES[Math.floor(Math.random() * SERVICES.length)];
            const status = Math.random() > 0.1 ? 'confirmed' : 'rejected';
            const code = generateCode();

            // createdAt: a few days before the appointment date
            const apptDate = new Date(date + 'T10:00:00');
            const createdOffset = Math.floor(Math.random() * 3) + 1;
            const createdAt = new Date(apptDate.getTime() - createdOffset * 86400000).toISOString();

            stmt.run(date, time, service.name, service.price, client.name, client.phone, client.email, code, status, createdAt);
            totalAppointments++;
        }
    });

    // Add some future/today appointments (pending and confirmed)
    const todayClients = [
        { idx: 0, time: "10:00", status: "confirmed" },
        { idx: 1, time: "10:30", status: "confirmed" },
        { idx: 3, time: "11:30", status: "pending" },
        { idx: 5, time: "15:00", status: "confirmed" },
        { idx: 7, time: "16:00", status: "pending" },
        { idx: 9, time: "17:30", status: "pending" },
    ];

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    todayClients.forEach(tc => {
        const client = CLIENTS[tc.idx];
        const service = SERVICES[Math.floor(Math.random() * SERVICES.length)];
        const code = generateCode();
        const createdAt = new Date(today.getTime() - 86400000).toISOString();
        stmt.run(todayStr, tc.time, service.name, service.price, client.name, client.phone, client.email, code, tc.status, createdAt);
        totalAppointments++;
    });

    // Add tomorrow appointments
    const tomorrow = new Date(today.getTime() + 86400000);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

    const tomorrowClients = [
        { idx: 2, time: "10:00", status: "confirmed" },
        { idx: 4, time: "11:00", status: "pending" },
        { idx: 6, time: "15:30", status: "pending" },
        { idx: 8, time: "17:00", status: "pending" },
    ];

    tomorrowClients.forEach(tc => {
        const client = CLIENTS[tc.idx];
        const service = SERVICES[Math.floor(Math.random() * SERVICES.length)];
        const code = generateCode();
        const createdAt = new Date().toISOString();
        stmt.run(tomorrowStr, tc.time, service.name, service.price, client.name, client.phone, client.email, code, tc.status, createdAt);
        totalAppointments++;
    });

    stmt.finalize();

    // Add one blocked phone
    db.run("INSERT INTO blocked_phones (phone, reason) VALUES (?, ?)",
        ["0899666777", "Не се явява на часове"]);

    console.log(`Seed complete: ${totalAppointments} appointments for ${CLIENTS.length} clients`);
    console.log(`Today (${todayStr}): ${todayClients.length} appointments`);
    console.log(`Tomorrow (${tomorrowStr}): ${tomorrowClients.length} appointments`);
    console.log(`1 blocked phone added`);

    db.close();
});
