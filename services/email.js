/**
 * Email Notification Service for Barbershop Halil
 *
 * Supports:
 * - Gmail (requires App Password)
 * - Any SMTP server
 *
 * For Gmail:
 * 1. Enable 2-Factor Authentication
 * 2. Go to https://myaccount.google.com/apppasswords
 * 3. Generate an App Password for "Mail"
 */

const nodemailer = require('nodemailer');

let transporter = null;
let db = null;

// Initialize Email Service
function initEmail(database) {
    db = database;

    const host = process.env.EMAIL_HOST;
    const port = process.env.EMAIL_PORT || 587;
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!user || !pass || user === 'your-email@gmail.com') {
        console.log('Email: No valid credentials configured. Email notifications disabled.');
        return false;
    }

    try {
        transporter = nodemailer.createTransport({
            host: host || 'smtp.gmail.com',
            port: parseInt(port),
            secure: port === '465',
            auth: {
                user: user,
                pass: pass
            }
        });

        // Verify connection
        transporter.verify((error, success) => {
            if (error) {
                console.log('Email: Connection verification failed:', error.message);
                transporter = null;
            } else {
                console.log('Email: Service initialized successfully');
            }
        });

        return true;
    } catch (error) {
        console.error('Email: Failed to initialize:', error);
        return false;
    }
}

// Send confirmation email
async function sendConfirmation(email, appointment) {
    if (!isEnabled()) {
        return false;
    }

    if (!email || !email.includes('@')) {
        console.log('Email: Invalid email address');
        return false;
    }

    try {
        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
                .container { max-width: 500px; margin: 0 auto; background: #1a1a2e; color: #fff; border-radius: 12px; overflow: hidden; }
                .header { background: linear-gradient(135deg, #d4af37, #b8962e); padding: 20px; text-align: center; }
                .header h1 { margin: 0; color: #1a1a2e; font-size: 24px; }
                .content { padding: 30px; }
                .success-badge { background: #00D68F; color: #fff; padding: 8px 16px; border-radius: 20px; display: inline-block; margin-bottom: 20px; }
                .details { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 20px; margin: 20px 0; }
                .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.1); }
                .detail-row:last-child { border-bottom: none; }
                .label { color: #888; }
                .value { color: #fff; font-weight: bold; }
                .code-box { background: rgba(212, 175, 55, 0.1); border: 2px dashed #d4af37; border-radius: 8px; padding: 15px; text-align: center; margin: 20px 0; }
                .code { font-size: 24px; font-weight: bold; color: #d4af37; letter-spacing: 3px; font-family: monospace; }
                .address { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 15px; margin-top: 20px; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>💈 Barbershop Halil</h1>
                </div>
                <div class="content">
                    <span class="success-badge">✅ Часът е потвърден!</span>

                    <div class="details">
                        <div class="detail-row">
                            <span class="label">📅 Дата</span>
                            <span class="value">${formatDate(appointment.date)}</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">⏰ Час</span>
                            <span class="value">${appointment.time}</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">✂️ Услуга</span>
                            <span class="value">${appointment.service}</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">💰 Цена</span>
                            <span class="value">${appointment.price} лв.</span>
                        </div>
                    </div>

                    <div class="code-box">
                        <div style="color: #888; margin-bottom: 5px;">Код за резервация:</div>
                        <div class="code">${appointment.confirmationCode || '-'}</div>
                    </div>

                    <div class="address">
                        <div style="color: #d4af37; margin-bottom: 10px;">📍 Адрес:</div>
                        <div>ул. „Коматевско шосе" 278</div>
                        <div style="color: #888;">кв. Коматево, Пловдив</div>
                    </div>

                    <p style="color: #888; text-align: center; margin-top: 20px;">
                        Ще ви изпратим напомняне 30 минути преди часа.
                    </p>
                </div>
                <div class="footer">
                    © 2026 Barbershop Halil | 📞 089 610 9709
                </div>
            </div>
        </body>
        </html>
        `;

        const info = await transporter.sendMail({
            from: `"Barbershop Halil" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `✅ Потвърден час - ${formatDate(appointment.date)} в ${appointment.time}`,
            html: html
        });

        console.log(`Email: Confirmation sent to ${email}`);
        return true;

    } catch (error) {
        console.error('Email: Failed to send confirmation:', error);
        return false;
    }
}

// Send rejection email
async function sendRejection(emailAddr, appointment) {
    if (!isEnabled()) {
        return false;
    }

    if (!emailAddr || !emailAddr.includes('@')) {
        console.log('Email: Invalid email address for rejection');
        return false;
    }

    try {
        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
                .container { max-width: 500px; margin: 0 auto; background: #1a1a2e; color: #fff; border-radius: 12px; overflow: hidden; }
                .header { background: #FF3D71; padding: 20px; text-align: center; }
                .header h1 { margin: 0; color: #fff; font-size: 24px; }
                .content { padding: 30px; }
                .reject-badge { background: #FF3D71; color: #fff; padding: 8px 16px; border-radius: 20px; display: inline-block; margin-bottom: 20px; }
                .details { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 20px; margin: 20px 0; }
                .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.1); }
                .detail-row:last-child { border-bottom: none; }
                .label { color: #888; }
                .value { color: #fff; font-weight: bold; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>💈 Barbershop Halil</h1>
                </div>
                <div class="content">
                    <span class="reject-badge">❌ Часът е отказан</span>

                    <p style="color: #ccc; margin: 15px 0;">
                        За съжаление, поради непредвидени обстоятелства Вашият запазен час не може да бъде осъществен. Извиняваме се за причиненото неудобство.
                    </p>
                    <p style="color: #ccc; margin: 10px 0;">
                        Моля, свържете се с нас или запазете нов час на удобно за Вас време.
                    </p>

                    <div class="details">
                        <div class="detail-row">
                            <span class="label">📅 Дата</span>
                            <span class="value">${formatDate(appointment.date)}</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">⏰ Час</span>
                            <span class="value">${appointment.time}</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">✂️ Услуга</span>
                            <span class="value">${appointment.service}</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">💰 Цена</span>
                            <span class="value">${appointment.price} лв.</span>
                        </div>
                    </div>

                    <p style="color: #888; text-align: center; margin-top: 20px;">
                        Можете да запазите нов час на нашия сайт.
                    </p>
                </div>
                <div class="footer">
                    © 2026 Barbershop Halil | 📞 089 610 9709
                </div>
            </div>
        </body>
        </html>
        `;

        await transporter.sendMail({
            from: `"Barbershop Halil" <${process.env.EMAIL_USER}>`,
            to: emailAddr,
            subject: `❌ Отказан час - ${formatDate(appointment.date)} в ${appointment.time}`,
            html: html
        });

        console.log(`Email: Rejection sent to ${emailAddr}`);
        return true;

    } catch (error) {
        console.error('Email: Failed to send rejection:', error);
        return false;
    }
}

// Send reminder email
async function sendReminder(email, appointment) {
    if (!isEnabled()) {
        return false;
    }

    if (!email || !email.includes('@')) {
        return false;
    }

    try {
        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
                .container { max-width: 500px; margin: 0 auto; background: #1a1a2e; color: #fff; border-radius: 12px; overflow: hidden; }
                .header { background: linear-gradient(135deg, #FF9500, #FF6B00); padding: 20px; text-align: center; }
                .header h1 { margin: 0; color: #fff; font-size: 24px; }
                .content { padding: 30px; text-align: center; }
                .time-big { font-size: 48px; font-weight: bold; color: #d4af37; margin: 20px 0; }
                .service { color: #888; font-size: 18px; }
                .address { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 15px; margin-top: 20px; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>⏰ Напомняне!</h1>
                </div>
                <div class="content">
                    <p>Вашият час при Barbershop Halil е след <strong>30 минути</strong></p>

                    <div class="time-big">${appointment.time}</div>
                    <div class="service">✂️ ${appointment.service}</div>

                    <div class="address">
                        <div style="color: #d4af37; margin-bottom: 10px;">📍 Адрес:</div>
                        <div>ул. „Коматевско шосе" 278</div>
                        <div style="color: #888;">кв. Коматево, Пловдив</div>
                    </div>

                    <p style="color: #d4af37; margin-top: 30px; font-size: 18px;">
                        Очакваме ви! 💈
                    </p>
                </div>
                <div class="footer">
                    © 2026 Barbershop Halil | 📞 089 610 9709
                </div>
            </div>
        </body>
        </html>
        `;

        await transporter.sendMail({
            from: `"Barbershop Halil" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `⏰ Напомняне: Часът ви е след 30 минути!`,
            html: html
        });

        console.log(`Email: Reminder sent to ${email}`);
        return true;

    } catch (error) {
        console.error('Email: Failed to send reminder:', error);
        return false;
    }
}

// Send admin notification email
async function sendAdminNotification(adminEmail, appointment, action) {
    if (!isEnabled()) {
        return false;
    }

    if (!adminEmail || !adminEmail.includes('@')) {
        return false;
    }

    const statusText = action === 'confirm' ? 'ПОТВЪРДЕН' : 'ОТКАЗАН';
    const statusEmoji = action === 'confirm' ? '✅' : '❌';
    const statusColor = action === 'confirm' ? '#00D68F' : '#FF3D71';

    try {
        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
                .container { max-width: 500px; margin: 0 auto; background: #1a1a2e; color: #fff; border-radius: 12px; overflow: hidden; }
                .header { background: ${statusColor}; padding: 15px; text-align: center; }
                .header h1 { margin: 0; color: #fff; font-size: 20px; }
                .content { padding: 25px; }
                .details { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 15px; margin: 15px 0; }
                .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.1); }
                .detail-row:last-child { border-bottom: none; }
                .label { color: #888; }
                .value { color: #fff; font-weight: bold; }
                .footer { text-align: center; padding: 15px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>${statusEmoji} Час ${statusText}</h1>
                </div>
                <div class="content">
                    <div class="details">
                        <div class="detail-row">
                            <span class="label">Клиент</span>
                            <span class="value">${appointment.clientName}</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">Телефон</span>
                            <span class="value">${appointment.clientPhone}</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">Дата</span>
                            <span class="value">${formatDate(appointment.date)}</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">Час</span>
                            <span class="value">${appointment.time}</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">Услуга</span>
                            <span class="value">${appointment.service}</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">Цена</span>
                            <span class="value">${appointment.price} лв.</span>
                        </div>
                        <div class="detail-row">
                            <span class="label">Код</span>
                            <span class="value">${appointment.confirmationCode || '-'}</span>
                        </div>
                    </div>
                </div>
                <div class="footer">
                    Barbershop Halil - Admin Notification
                </div>
            </div>
        </body>
        </html>
        `;

        await transporter.sendMail({
            from: `"Barbershop Halil" <${process.env.EMAIL_USER}>`,
            to: adminEmail,
            subject: `${statusEmoji} ${statusText}: ${appointment.clientName} - ${formatDate(appointment.date)} ${appointment.time}`,
            html: html
        });

        return true;
    } catch (error) {
        console.error('Email: Failed to send admin notification:', error);
        return false;
    }
}

// Format date for Bulgarian display
function formatDate(dateStr) {
    const date = new Date(dateStr);
    const days = ['Неделя', 'Понеделник', 'Вторник', 'Сряда', 'Четвъртък', 'Петък', 'Събота'];
    const months = ['януари', 'февруари', 'март', 'април', 'май', 'юни',
                    'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];

    return `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]}`;
}

// Check if Email is enabled
function isEnabled() {
    return transporter !== null;
}

module.exports = {
    initEmail,
    sendConfirmation,
    sendRejection,
    sendReminder,
    sendAdminNotification,
    isEnabled
};
