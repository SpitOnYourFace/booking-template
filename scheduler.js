const cron = require('node-cron');

let db = null;
let telegramService = null;
let emailService = null;

// Initialize scheduler with database and notification services
function initScheduler(database, telegram, email) {
    db = database;
    telegramService = telegram;
    emailService = email;

    // Run every minute to check for upcoming appointments
    cron.schedule('* * * * *', () => {
        checkUpcomingAppointments();
    });

    console.log('Scheduler: Reminder scheduler started (checking every minute)');
}

// Check for appointments that need reminders
async function checkUpcomingAppointments() {
    if (!db) {
        console.error('Scheduler: Database not initialized');
        return;
    }

    // Check if at least one notification service is enabled
    const telegramEnabled = telegramService && telegramService.isEnabled();
    const emailEnabled = emailService && emailService.isEnabled();

    if (!telegramEnabled && !emailEnabled) {
        return; // No notification services configured, skip silently
    }

    // Get current date and time
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // Calculate time 30 minutes from now
    const reminderTime = new Date(now.getTime() + 30 * 60 * 1000);
    const reminderHour = reminderTime.getHours().toString().padStart(2, '0');
    const reminderMinute = reminderTime.getMinutes().toString().padStart(2, '0');
    const targetTime = `${reminderHour}:${reminderMinute}`;

    // Find appointments that:
    // - Are today
    // - Are confirmed
    // - Start at the target time (30 min from now)
    // - Haven't received a reminder yet
    const query = `
        SELECT * FROM appointments
        WHERE date = ?
        AND time = ?
        AND status = 'confirmed'
        AND (reminderSent IS NULL OR reminderSent = 0)
    `;

    db.all(query, [today, targetTime], async (err, appointments) => {
        if (err) {
            console.error('Scheduler: Error querying appointments:', err);
            return;
        }

        if (appointments.length === 0) {
            return; // No appointments to remind
        }

        console.log(`Scheduler: Found ${appointments.length} appointment(s) to remind`);

        for (const appointment of appointments) {
            let reminderSent = false;

            // Try Telegram
            if (telegramEnabled) {
                try {
                    const sent = await telegramService.sendReminder(appointment.clientPhone, appointment);
                    if (sent) {
                        reminderSent = true;
                        console.log(`Scheduler: Telegram reminder sent for appointment ${appointment.id}`);
                    }
                } catch (e) {
                    console.error(`Scheduler: Telegram reminder failed for appointment ${appointment.id}:`, e);
                }
            }

            // Try Email
            if (emailEnabled && appointment.clientEmail) {
                try {
                    const sent = await emailService.sendReminder(appointment.clientEmail, appointment);
                    if (sent) {
                        reminderSent = true;
                        console.log(`Scheduler: Email reminder sent for appointment ${appointment.id}`);
                    }
                } catch (e) {
                    console.error(`Scheduler: Email reminder failed for appointment ${appointment.id}:`, e);
                }
            }

            // Mark reminder as sent if at least one notification went through
            if (reminderSent) {
                db.run(
                    'UPDATE appointments SET reminderSent = 1 WHERE id = ?',
                    [appointment.id],
                    (err) => {
                        if (err) {
                            console.error(`Scheduler: Failed to mark reminder sent for appointment ${appointment.id}:`, err);
                        }
                    }
                );
            }
        }
    });
}

// Manual trigger for testing
function triggerReminderCheck() {
    console.log('Scheduler: Manual reminder check triggered');
    checkUpcomingAppointments();
}

module.exports = {
    initScheduler,
    triggerReminderCheck
};
