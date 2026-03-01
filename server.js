require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const compression = require('compression');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const config = require('./config.json');
const telegram = require('./services/telegram');
const email = require('./services/email');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

const SERVICES = {};
config.services.forEach(s => { SERVICES[s.name] = s.price; });
const WORK_HOURS = config.workHours.slots;
const STYLISTS = config.stylists || [];
const PHONE_REGEX = new RegExp(config.booking.phoneRegex);

app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false, saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 86400000 }
}));

function injectOgMeta(htmlFile, overrides = {}) {
    const filePath = path.join(__dirname, 'public', htmlFile);
    let html = fs.readFileSync(filePath, 'utf8');
    const ogUrl = config.seo.ogUrl || '';
    const replacements = { 'og:title': overrides.ogTitle || config.seo.title, 'og:description': overrides.ogDescription || config.seo.description, 'og:url': overrides.ogUrl || ogUrl, 'og:site_name': config.business.name };
    for (const [prop, value] of Object.entries(replacements)) {
        const attr = prop.startsWith('og:') ? 'property' : 'name';
        html = html.replace(new RegExp(`<meta ${attr}="${prop}"[^>]*content=""[^>]*>`, 'g'), `<meta ${attr}="${prop}" content="${value}">`);
    }
    return html;
}

app.get('/', (req, res) => res.type('html').send(injectOgMeta('index.html')));
app.get('/index.html', (req, res) => res.type('html').send(injectOgMeta('index.html')));
app.get('/admin.html', (req, res) => res.type('html').send(injectOgMeta('admin.html', { ogTitle: config.admin.title + ' - ' + config.business.name })));

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '0', etag: true, lastModified: true,
    setHeaders: (res, fp) => { res.setHeader('Cache-Control', fp.match(/\.(svg|png|jpg)$/) ? 'public, max-age=3600, must-revalidate' : 'no-cache, must-revalidate'); }
}));

const DB_PATH = process.env.NODE_ENV === 'production' ? '/tmp/appointments.db' : './appointments.db';
const db = new sqlite3.Database(DB_PATH, (err) => { if (err) console.error(err.message); else console.log('Connected to SQLite'); });

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, time TEXT, service TEXT, price INTEGER DEFAULT 0,
        stylist TEXT, clientName TEXT, clientPhone TEXT, clientEmail TEXT,
        status TEXT DEFAULT 'pending', confirmationCode TEXT, reminderSent INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS telegram_subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, chatId TEXT UNIQUE, phone TEXT UNIQUE, name TEXT, subscribedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS blocked_phones (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE, reason TEXT, blockedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run("CREATE INDEX IF NOT EXISTS idx_appt_date_status ON appointments(date, status)");
    db.run("CREATE INDEX IF NOT EXISTS idx_appt_phone ON appointments(clientPhone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_appt_code ON appointments(confirmationCode)");
    db.run("CREATE INDEX IF NOT EXISTS idx_appt_stylist ON appointments(stylist, date)");

    // Migrations
    db.all("PRAGMA table_info(appointments)", (err, columns) => {
        if (err) return;
        const cols = (columns||[]).map(c => c.name);
        [['price','ALTER TABLE appointments ADD COLUMN price INTEGER DEFAULT 0'],['createdAt','ALTER TABLE appointments ADD COLUMN createdAt DATETIME DEFAULT CURRENT_TIMESTAMP'],['confirmationCode','ALTER TABLE appointments ADD COLUMN confirmationCode TEXT'],['reminderSent','ALTER TABLE appointments ADD COLUMN reminderSent INTEGER DEFAULT 0'],['clientEmail','ALTER TABLE appointments ADD COLUMN clientEmail TEXT'],['stylist','ALTER TABLE appointments ADD COLUMN stylist TEXT']].forEach(([n,s]) => { if (!cols.includes(n)) { console.log('Migrating: '+n); db.run(s); } });
    });

    // Seed
    db.get("SELECT COUNT(*) as count FROM appointments", [], (err, row) => {
        if (err || (row && row.count > 0)) return;
        const today = new Date();
        const fmt = d => d.toISOString().split('T')[0];
        const dd = o => fmt(new Date(today.getTime() + o * 86400000));
        const prefix = config.booking.confirmationPrefix || 'FY';
        const sn = STYLISTS.length > 0 ? STYLISTS.map(s => s.name) : [null];
        const seed = [
            [dd(0),'09:00','Подстригване',25,sn[0],'Мария Иванова','0887123456','maria@mail.bg','confirmed',prefix+'-1001'],
            [dd(0),'10:00','Маникюр',35,sn[2%sn.length],'Десислава Петрова','0898765432',null,'confirmed',prefix+'-1002'],
            [dd(0),'11:00','Терапия за лице',45,sn[1%sn.length],'Ивана Стоянова','0879111222',null,'pending',prefix+'-1003'],
            [dd(0),'14:00','Боядисване',50,sn[0],'Елена Тодорова','0888333444','elena@gmail.com','pending',prefix+'-1004'],
            [dd(0),'15:30','Педикюр',40,sn[3%sn.length],'Анна Колева','0897555666',null,'pending',prefix+'-1005'],
            [dd(0),'09:30','Масаж',50,sn[3%sn.length],'Габриела Димитрова','0889222333',null,'confirmed',prefix+'-1020'],
            [dd(1),'10:30','Подстригване',25,sn[0],'Стефка Георгиева','0887222333','stefka@abv.bg','confirmed',prefix+'-1006'],
            [dd(1),'12:00','Боядисване',50,sn[1%sn.length],'Красимира Маринова','0878444555',null,'pending',prefix+'-1007'],
            [dd(1),'15:30','Маникюр',35,sn[2%sn.length],'Нина Костова','0889666777',null,'confirmed',prefix+'-1008'],
            [dd(2),'11:00','Терапия за лице',45,sn[1%sn.length],'Петя Николова','0897888999','petya@mail.bg','pending',prefix+'-1009'],
            [dd(-1),'10:00','Подстригване',25,sn[0],'Диана Василева','0887111000',null,'confirmed',prefix+'-0901'],
            [dd(-1),'11:30','Маникюр',35,sn[2%sn.length],'Радостина Христова','0898222111',null,'confirmed',prefix+'-0902'],
            [dd(-1),'16:00','Масаж',50,sn[3%sn.length],'Калина Атанасова','0879333222',null,'confirmed',prefix+'-0903'],
            [dd(-2),'10:30','Боядисване',50,sn[0],'Василка Добрева','0888444333',null,'confirmed',prefix+'-0904'],
            [dd(-2),'15:00','Терапия за лице',45,sn[1%sn.length],'Емилия Стоева','0897555444',null,'confirmed',prefix+'-0905'],
            [dd(-3),'11:00','Педикюр',40,sn[4%sn.length],'Анна Попова','0887666555',null,'confirmed',prefix+'-0906'],
            [dd(-3),'12:00','Подстригване',25,sn[0],'Мартина Ковачева','0898777666',null,'confirmed',prefix+'-0907'],
            [dd(-3),'16:30','Маникюр',35,sn[2%sn.length],'Христина Йорданова','0879888777',null,'rejected',prefix+'-0908'],
            [dd(-4),'10:00','Масаж',50,sn[3%sn.length],'Даниела Кръстева','0888999888',null,'confirmed',prefix+'-0909'],
            [dd(-4),'15:30','Боядисване',50,sn[0],'Пламена Костова','0897000999',null,'confirmed',prefix+'-0910'],
            [dd(-5),'11:30','Подстригване',25,sn[1%sn.length],'Ралица Генчева','0887111222',null,'confirmed',prefix+'-0911'],
            [dd(-5),'17:00','Терапия за лице',45,sn[1%sn.length],'Ивелина Методиева','0898222333',null,'confirmed',prefix+'-0912'],
        ];
        const stmt = db.prepare("INSERT INTO appointments (date,time,service,price,stylist,clientName,clientPhone,clientEmail,status,confirmationCode) VALUES (?,?,?,?,?,?,?,?,?,?)");
        seed.forEach(r => stmt.run(r));
        stmt.finalize();
        console.log('Seed: '+seed.length+' demo appointments');
    });

    setTimeout(() => { telegram.initTelegram(db, config); email.initEmail(db, config); scheduler.initScheduler(db, telegram, email); }, 1000);
});

function generateConfirmationCode() {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = (config.booking.confirmationPrefix||'FY')+'-';
    for (let i=0;i<6;i++) code += c.charAt(Math.floor(Math.random()*c.length));
    return code;
}

function requireAuth(req,res,next) { return next(); }

// PUBLIC API
app.get('/api/config', (req,res) => res.json({ business:config.business, theme:config.theme, services:config.services, workHours:config.workHours, booking:config.booking, seo:config.seo, admin:config.admin, stylists:config.stylists||[] }));
app.get('/api/health', (req,res) => res.json({ status:'ok', timestamp:new Date().toISOString(), uptime:process.uptime() }));

// Slots — per-stylist aware
app.get('/api/slots', (req,res) => {
    const {date,stylist} = req.query;
    if (!date||!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({error:"Valid date required"});
    let q = "SELECT time, stylist FROM appointments WHERE date = ? AND status IN ('pending','confirmed')";
    let p = [date];
    if (stylist) { q += " AND stylist = ?"; p.push(stylist); }
    db.all(q, p, (err,rows) => {
        if (err) return res.status(500).json({error:err.message});
        const booked = {};
        rows.forEach(r => { booked[r.time] = (booked[r.time]||0)+1; });
        const total = stylist ? 1 : (STYLISTS.length||1);
        res.json(WORK_HOURS.map(time => ({ time, status: (booked[time]||0) >= total ? 'taken' : 'free', available: total-(booked[time]||0) })));
    });
});

// Available stylists for date+time
app.get('/api/available-stylists', (req,res) => {
    const {date,time} = req.query;
    if (!date||!time) return res.status(400).json({error:"Date and time required"});
    db.all("SELECT stylist FROM appointments WHERE date=? AND time=? AND status IN ('pending','confirmed')", [date,time], (err,rows) => {
        if (err) return res.status(500).json({error:err.message});
        const booked = new Set(rows.map(r=>r.stylist));
        res.json(STYLISTS.filter(s => !booked.has(s.name)));
    });
});

app.get('/api/status/:code', (req,res) => {
    const {code} = req.params;
    if (!code||code.length<5) return res.status(400).json({error:"Invalid"});
    db.get("SELECT id,date,time,service,status,clientName,stylist FROM appointments WHERE confirmationCode=?", [code.toUpperCase()], (err,row) => {
        if (err) return res.status(500).json({error:"DB error"});
        if (!row) return res.status(404).json({error:"Not found"});
        res.json({found:true, status:row.status, date:row.date, time:row.time, service:row.service, name:row.clientName, stylist:row.stylist});
    });
});

app.post('/api/book', (req,res) => {
    const {date,time,service,clientName,clientPhone,clientEmail,stylist} = req.body;
    if (!date||!time||!clientName||!clientPhone||!service) return res.status(400).json({error:"Missing fields"});
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({error:"Invalid date"});
    if (!WORK_HOURS.includes(time)) return res.status(400).json({error:"Invalid time"});
    const price = SERVICES[service];
    if (price===undefined) return res.status(400).json({error:"Invalid service"});
    const cp = clientPhone.replace(/[^0-9+]/g,'');
    if (!PHONE_REGEX.test(cp)) return res.status(400).json({error:"Invalid phone"});
    if (clientEmail && !clientEmail.includes('@')) return res.status(400).json({error:"Invalid email"});
    let phone = cp; if (phone.startsWith('+359')) phone='0'+phone.slice(4);
    const name = clientName.replace(/[<>]/g,'').trim().substring(0,100);
    const em = clientEmail ? clientEmail.trim().toLowerCase().substring(0,100) : null;
    const st = stylist||null;
    const code = generateConfirmationCode();

    db.get("SELECT id FROM blocked_phones WHERE phone=?", [phone], (err,bl) => {
        if (err) return res.status(500).json({error:"DB error"});
        if (bl) return res.status(403).json({error:"blocked"});
        let sq = "SELECT id FROM appointments WHERE date=? AND time=? AND status IN ('pending','confirmed')";
        let sp = [date,time];
        if (st) { sq+=" AND stylist=?"; sp.push(st); }
        db.get(sq, sp, (err,row) => {
            if (err) return res.status(500).json({error:"DB error"});
            if (row) return res.status(409).json({error:"Slot taken"});
            db.run("INSERT INTO appointments (date,time,service,price,stylist,clientName,clientPhone,clientEmail,confirmationCode,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
                [date,time,service,price,st,name,phone,em,code,new Date().toISOString()], function(err) {
                if (err) return res.status(500).json({error:"Failed"});
                if (telegram.isEnabled()) telegram.sendAdminNewBooking({clientName:name,clientPhone:phone,date,time,service,price,stylist:st}).catch(()=>{});
                res.json({id:this.lastID, confirmationCode:code, message:"Request sent"});
            });
        });
    });
});

// ADMIN
app.post('/api/admin/login', (req,res) => {
    const {username,password}=req.body;
    if (username===(process.env.ADMIN_USERNAME||'admin') && password===(process.env.ADMIN_PASSWORD||'admin123')) { req.session.isAdmin=true; res.json({success:true}); }
    else res.status(401).json({error:'Invalid credentials'});
});
app.post('/api/admin/logout', (req,res) => { req.session.destroy(()=>res.json({success:true})); });
app.get('/api/admin/check-auth', (req,res) => res.json({authenticated:true}));

app.get('/api/admin/appointments', requireAuth, (req,res) => {
    const {search}=req.query; let q="SELECT * FROM appointments", p=[];
    if (search&&search.trim()) { const s=`%${search.trim()}%`; q+=" WHERE clientName LIKE ? COLLATE NOCASE OR clientPhone LIKE ? OR confirmationCode LIKE ? COLLATE NOCASE OR clientEmail LIKE ? COLLATE NOCASE OR date LIKE ? OR stylist LIKE ? COLLATE NOCASE"; p=[s,s,s,s,s,s]; }
    q+=" ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, date DESC, time DESC LIMIT 100";
    db.all(q,p,(err,rows) => { if(err) return res.status(500).json({error:err.message}); res.json(rows); });
});

app.get('/api/admin/stats', requireAuth, (req,res) => {
    const today=new Date().toISOString().split('T')[0];
    db.get("SELECT COUNT(*) as total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending, SUM(CASE WHEN status='confirmed' THEN price ELSE 0 END) as revenue FROM appointments", [], (err,row) => {
        if(err) return res.status(500).json({error:err.message}); res.json(row);
    });
});

app.get('/api/admin/notifications', requireAuth, (req,res) => {
    db.all("SELECT id,clientName,clientPhone,service,date,time,status,stylist,createdAt FROM appointments WHERE status='pending' ORDER BY createdAt DESC LIMIT 20", [], (err,rows) => {
        if(err) return res.status(500).json({error:err.message}); res.json(rows||[]);
    });
});

app.post('/api/admin/action', requireAuth, (req,res) => {
    const {id,action}=req.body;
    if (!id||!['confirm','reject'].includes(action)) return res.status(400).json({error:"Invalid"});
    const status = action==='confirm'?'confirmed':'rejected';
    db.get("SELECT * FROM appointments WHERE id=?", [id], (err,appt) => {
        if(err) return res.status(500).json({error:err.message});
        if(!appt) return res.status(404).json({error:"Not found"});
        db.run("UPDATE appointments SET status=? WHERE id=?", [status,id], async function(err) {
            if(err) return res.status(500).json({error:err.message});
            let notif={telegram:false,email:false};
            if(action==='confirm') {
                if(telegram.isEnabled()) try{notif.telegram=await telegram.sendConfirmation(appt.clientPhone,appt)}catch(e){}
                if(email.isEnabled()&&appt.clientEmail) try{notif.email=await email.sendConfirmation(appt.clientEmail,appt)}catch(e){}
            } else {
                if(email.isEnabled()&&appt.clientEmail) try{notif.email=await email.sendRejection(appt.clientEmail,appt)}catch(e){}
            }
            res.json({success:true,notifications:notif});
        });
    });
});

app.post('/api/admin/edit', requireAuth, (req,res) => {
    const {id,clientName}=req.body; if(!id||!clientName) return res.status(400).json({error:"Missing"});
    db.run("UPDATE appointments SET clientName=? WHERE id=?", [clientName.replace(/[<>]/g,'').trim().substring(0,100),id], function(err) { if(err) return res.status(500).json({error:err.message}); res.json({success:true}); });
});

app.post('/api/admin/edit-client', requireAuth, (req,res) => {
    const {phone,clientName}=req.body; if(!phone||!clientName) return res.status(400).json({error:"Missing"});
    db.run("UPDATE appointments SET clientName=? WHERE clientPhone=?", [clientName.replace(/[<>]/g,'').trim().substring(0,100),phone], function(err) { if(err) return res.status(500).json({error:err.message}); res.json({success:true,updated:this.changes}); });
});

app.get('/api/admin/clients', requireAuth, (req,res) => {
    db.all("SELECT clientName,clientPhone,clientEmail,date,price FROM appointments WHERE status='confirmed'", [], (err,rows) => {
        if(err) return res.status(500).json({error:err.message});
        const m={};
        rows.forEach(r => { if(!r.clientPhone) return; let p=r.clientPhone.replace(/[^0-9+]/g,''); if(p.startsWith('+359'))p='0'+p.slice(4);
            if(!m[p]) m[p]={name:r.clientName,phone:p,email:r.clientEmail,visits:0,totalSpent:0,lastVisit:r.date};
            m[p].visits++; m[p].totalSpent+=(r.price||0); if(r.date>m[p].lastVisit){m[p].name=r.clientName;m[p].lastVisit=r.date;if(r.clientEmail)m[p].email=r.clientEmail;} });
        res.json(Object.values(m).sort((a,b)=>b.visits-a.visits||b.totalSpent-a.totalSpent));
    });
});

app.get('/api/admin/schedule', requireAuth, (req,res) => {
    const {date}=req.query; if(!date||!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({error:"Valid date required"});
    db.all("SELECT * FROM appointments WHERE date=? AND status IN ('pending','confirmed') ORDER BY time ASC", [date], (err,rows) => { if(err) return res.status(500).json({error:err.message}); res.json(rows); });
});

app.post('/api/admin/block-phone', requireAuth, (req,res) => {
    const {phone,reason}=req.body; if(!phone) return res.status(400).json({error:"Missing"});
    let p=phone.replace(/[^0-9+]/g,''); if(p.startsWith('+359'))p='0'+p.slice(4);
    db.run("INSERT OR IGNORE INTO blocked_phones (phone,reason) VALUES (?,?)", [p,reason||null], function(err) { if(err) return res.status(500).json({error:err.message}); res.json({success:true,blocked:p}); });
});

app.post('/api/admin/unblock-phone', requireAuth, (req,res) => {
    const {phone}=req.body; if(!phone) return res.status(400).json({error:"Missing"});
    let p=phone.replace(/[^0-9+]/g,''); if(p.startsWith('+359'))p='0'+p.slice(4);
    db.run("DELETE FROM blocked_phones WHERE phone=?", [p], function(err) { if(err) return res.status(500).json({error:err.message}); res.json({success:true}); });
});

app.get('/api/admin/blocked-phones', requireAuth, (req,res) => {
    db.all("SELECT * FROM blocked_phones ORDER BY blockedAt DESC", [], (err,rows) => { if(err) return res.status(500).json({error:err.message}); res.json(rows||[]); });
});

app.post('/api/check-phone', (req,res) => {
    const {phone}=req.body; if(!phone) return res.status(400).json({error:"Missing"});
    let p=phone.replace(/[^0-9+]/g,''); if(p.startsWith('+359'))p='0'+p.slice(4);
    db.get("SELECT id FROM blocked_phones WHERE phone=?", [p], (err,row) => { if(err) return res.status(500).json({error:"DB error"}); res.json({blocked:!!row}); });
});

// Chart — FIXED: was referencing non-existent 'bookings' table
app.get('/api/admin/chart-data', requireAuth, (req,res) => {
    const days=[]; for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);days.push(d.toISOString().split('T')[0]);}
    const dn=['Нед','Пон','Вто','Сря','Чет','Пет','Съб'];
    db.all(`SELECT date, COUNT(*) as count FROM appointments WHERE date IN (${days.map(()=>'?').join(',')}) AND status IN ('confirmed','pending') GROUP BY date`, days, (err,rows) => {
        if(err) return res.status(500).json({error:err.message});
        const m={}; (rows||[]).forEach(r=>{m[r.date]=r.count;});
        res.json({labels:days.map(d=>dn[new Date(d+'T00:00:00').getDay()]), values:days.map(d=>m[d]||0)});
    });
});

app.listen(PORT, () => { console.log(`Server: http://localhost:${PORT}`); console.log(`Admin: http://localhost:${PORT}/admin.html`); });
