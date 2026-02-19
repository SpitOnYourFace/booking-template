/**
 * Telegram Bot Service for Barbershop Halil
 *
 * How to create a bot:
 * 1. Open Telegram and search for @BotFather
 * 2. Send /newbot
 * 3. Follow instructions to get your token
 */

const https = require('https');

let db = null;
let botToken = null;

// Initialize Telegram Bot
function initTelegram(database) {
    db = database;
    botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken || botToken === 'your-telegram-bot-token-here') {
        console.log('Telegram: No valid token configured. Telegram notifications disabled.');
        return false;
    }

    console.log('Telegram: Bot initialized successfully');

    // Start polling for messages (to register subscribers)
    startPolling();

    return true;
}

// Long polling for incoming messages
let pollingOffset = 0;
let pollingActive = false;

function startPolling() {
    if (pollingActive) return;
    pollingActive = true;

    console.log('Telegram: Starting message polling...');
    pollMessages();
}

function pollMessages() {
    if (!botToken || !pollingActive) return;

    const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${pollingOffset}&timeout=30`;

    https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(data);
                if (response.ok && response.result) {
                    response.result.forEach(update => {
                        pollingOffset = update.update_id + 1;
                        handleUpdate(update);
                    });
                }
            } catch (e) {
                console.error('Telegram: Error parsing response:', e.message);
            }

            // Continue polling
            setTimeout(pollMessages, 1000);
        });
    }).on('error', (e) => {
        console.error('Telegram: Polling error:', e.message);
        setTimeout(pollMessages, 5000);
    });
}

// Handle incoming updates
function handleUpdate(update) {
    if (!update.message) return;

    const chatId = update.message.chat.id;
    const text = update.message.text || '';
    const firstName = update.message.from.first_name || '';

    console.log(`Telegram: Message from ${chatId}: ${text}`);

    // Check for /start command
    if (text === '/start') {
        sendMessage(chatId,
            `Здравейте, ${firstName}! 👋\n\n` +
            `Добре дошли в Barbershop Halil!\n\n` +
            `За да получавате известия за резервациите си, моля изпратете вашия телефонен номер.\n\n` +
            `Пример: 0888123456`
        );
        return;
    }

    // Admin command - shows chat ID for .env configuration
    if (text === '/admin') {
        sendMessage(chatId,
            `🔑 <b>Вашият Chat ID:</b> <code>${chatId}</code>\n\n` +
            `Добавете го в .env файла:\n` +
            `<code>TELEGRAM_ADMIN_CHAT_ID=${chatId}</code>`
        );
        return;
    }

    // Check if it's a phone number
    const phoneRegex = /^(\+359|0)8[7-9][0-9]{7}$/;
    const cleanPhone = text.replace(/[^0-9+]/g, '');

    if (phoneRegex.test(cleanPhone)) {
        // Normalize phone
        let normalizedPhone = cleanPhone;
        if (normalizedPhone.startsWith('+359')) {
            normalizedPhone = '0' + normalizedPhone.slice(4);
        }

        // Save subscriber
        saveSubscriber(chatId, normalizedPhone, firstName)
            .then(() => {
                sendMessage(chatId,
                    `✅ Телефонът ${normalizedPhone} е регистриран!\n\n` +
                    `Сега ще получавате:\n` +
                    `• Потвърждение когато часът ви е одобрен\n` +
                    `• Напомняне 30 мин. преди часа\n\n` +
                    `Благодарим ви! 💈`
                );
            })
            .catch(err => {
                console.error('Telegram: Failed to save subscriber:', err);
                sendMessage(chatId, `❌ Възникна грешка. Моля, опитайте отново.`);
            });
    } else if (text !== '/start') {
        sendMessage(chatId,
            `Моля, изпратете валиден телефонен номер.\n\n` +
            `Пример: 0888123456 или +359888123456`
        );
    }
}

// Send message via Telegram API
function sendMessage(chatId, text) {
    return new Promise((resolve, reject) => {
        if (!botToken) {
            return reject(new Error('Bot token not configured'));
        }

        const postData = JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML'
        });

        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${botToken}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.ok) {
                        resolve(response.result);
                    } else {
                        reject(new Error(response.description || 'Unknown error'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// Save subscriber to database
function saveSubscriber(chatId, phone, name) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not initialized'));

        const stmt = db.prepare(`
            INSERT OR REPLACE INTO telegram_subscribers (chatId, phone, name, subscribedAt)
            VALUES (?, ?, ?, datetime('now'))
        `);

        stmt.run(chatId.toString(), phone, name || 'Unknown', function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
    });
}

// Get Telegram chat ID by phone number
function getChatIdByPhone(phone) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not initialized'));

        let normalizedPhone = phone.replace(/[^0-9+]/g, '');
        if (normalizedPhone.startsWith('+359')) {
            normalizedPhone = '0' + normalizedPhone.slice(4);
        }

        db.get('SELECT chatId FROM telegram_subscribers WHERE phone = ?', [normalizedPhone], (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.chatId : null);
        });
    });
}

// Send confirmation message
async function sendConfirmation(phone, appointment) {
    if (!isEnabled()) {
        return false;
    }

    try {
        const chatId = await getChatIdByPhone(phone);
        if (!chatId) {
            console.log(`Telegram: No subscriber found for phone ${phone}`);
            return false;
        }

        const message =
            `✅ <b>Вашият час е потвърден!</b>\n\n` +
            `📅 Дата: ${formatDate(appointment.date)}\n` +
            `⏰ Час: ${appointment.time}\n` +
            `✂️ Услуга: ${appointment.service}\n` +
            `💰 Цена: ${appointment.price} лв.\n\n` +
            `📍 <b>Адрес:</b>\n` +
            `ул. „Коматевско шосе" 278\n` +
            `кв. Коматево, Пловдив\n\n` +
            `🎫 Код: <code>${appointment.confirmationCode || '-'}</code>\n\n` +
            `⏰ Ще получите напомняне 30 мин. преди часа.`;

        await sendMessage(chatId, message);
        console.log(`Telegram: Confirmation sent to ${phone}`);
        return true;

    } catch (error) {
        console.error('Telegram: Failed to send confirmation:', error);
        return false;
    }
}

// Send reminder message
async function sendReminder(phone, appointment) {
    if (!isEnabled()) {
        return false;
    }

    try {
        const chatId = await getChatIdByPhone(phone);
        if (!chatId) {
            console.log(`Telegram: No subscriber found for phone ${phone}`);
            return false;
        }

        const message =
            `⏰ <b>Напомняне!</b>\n\n` +
            `Вашият час при Barbershop Halil е след <b>30 минути</b>.\n\n` +
            `⏰ ${appointment.time}\n` +
            `✂️ ${appointment.service}\n\n` +
            `📍 ул. „Коматевско шосе" 278\n` +
            `кв. Коматево, Пловдив\n\n` +
            `Очакваме ви! 💈`;

        await sendMessage(chatId, message);
        console.log(`Telegram: Reminder sent to ${phone}`);
        return true;

    } catch (error) {
        console.error('Telegram: Failed to send reminder:', error);
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

// Send admin notification for new booking
async function sendAdminNewBooking(appointment) {
    if (!isEnabled()) return false;

    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!adminChatId) {
        console.log('Telegram: No TELEGRAM_ADMIN_CHAT_ID configured');
        return false;
    }

    try {
        const message =
            `🆕 <b>Нова заявка!</b>\n\n` +
            `👤 ${appointment.clientName}\n` +
            `📞 ${appointment.clientPhone}\n` +
            `📅 ${formatDate(appointment.date)} в ${appointment.time}\n` +
            `✂️ ${appointment.service}\n` +
            `💰 ${appointment.price} лв.`;

        await sendMessage(adminChatId, message);
        console.log('Telegram: Admin notified about new booking');
        return true;
    } catch (error) {
        console.error('Telegram: Failed to notify admin:', error);
        return false;
    }
}

// Check if Telegram is enabled
function isEnabled() {
    return botToken && botToken !== 'your-telegram-bot-token-here';
}

// Stop polling (for cleanup)
function stopPolling() {
    pollingActive = false;
}

module.exports = {
    initTelegram,
    sendConfirmation,
    sendReminder,
    sendAdminNewBooking,
    getChatIdByPhone,
    isEnabled,
    stopPolling
};
