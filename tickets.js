const crypto = require('crypto');
const { getDb } = require('./database');
const { sendTicketEmail } = require('./email');
const { eventFilter } = require('./content');

/* =====================================================
   TICKETS
   One place that creates tickets, so the frontend payment
   callback, the Razorpay webhook and free registrations all
   produce the same ticket shape and never duplicate.
   ===================================================== */

// Razorpay's fee is passed on to the buyer.
const RAZORPAY_FEE_FACTOR = 0.9764;
const chargeFor = (ticketPrice) => Math.ceil(Number(ticketPrice) / RAZORPAY_FEE_FACTOR);

// Unguessable, so a ticket cannot be forged by predicting the next id.
const newTicketId = () => `TKT-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

async function ensureTicketIndexes() {
  const tickets = getDb().collection('tickets');
  try {
    // Stops the webhook and the payment callback from both creating a ticket
    // for the same payment when they arrive at the same moment.
    await tickets.createIndex(
      { payment_id: 1 },
      { unique: true, partialFilterExpression: { payment_id: { $type: 'string' } } }
    );
  } catch (err) {
    console.error(
      '⚠️  Could not create unique index on tickets.payment_id. ' +
        'There are probably duplicate tickets for one payment already; remove them and restart.',
      err.message
    );
  }
  await tickets.createIndex({ eventId: 1, email: 1 });
}

async function findEvent({ eventId, eventTitle }) {
  const events = getDb().collection('events');
  if (eventId) return events.findOne(eventFilter(String(eventId)));
  // Older frontends only send the title.
  if (eventTitle) return events.findOne({ title: String(eventTitle) });
  return null;
}

/**
 * Creates a ticket and emails it. Safe to call more than once for the same
 * payment: the second call returns the existing ticket and sends nothing.
 */
async function createTicket({ event, name, email, formData, paymentId }) {
  const tickets = getDb().collection('tickets');
  const ticket = {
    _id: newTicketId(),
    event: event.title,
    eventId: event.id || String(event._id),
    primary_name: name || 'Guest',
    email,
    formData: formData || {},
    status_day_1: 'pending',
    status_day_2: 'pending',
    createdAt: new Date(),
  };
  if (paymentId) ticket.payment_id = paymentId;

  try {
    await tickets.insertOne(ticket);
  } catch (err) {
    if (err.code === 11000 && paymentId) {
      return { ticket: await tickets.findOne({ payment_id: paymentId }), created: false };
    }
    throw err;
  }

  sendTicketEmail({
    id: ticket._id,
    event: event.title,
    date: event.date,
    time: event.time,
    location: event.location,
    primary_name: ticket.primary_name,
    email,
  }).catch((err) => console.error('Email error:', err));

  return { ticket, created: true };
}

/**
 * Marks a ticket as checked in for a day. The update is atomic, so two
 * scanners reading the same QR code at once cannot both admit it.
 */
async function checkInTicket(rawTicketId, day) {
  const ticketId = String(rawTicketId || '').trim();
  if (!['1', '2'].includes(String(day))) {
    return { status: 400, success: false, message: 'Day must be 1 or 2' };
  }
  if (!ticketId || ticketId.length > 100) {
    return { status: 400, success: false, message: 'Invalid ticket code' };
  }

  const tickets = getDb().collection('tickets');
  const statusField = `status_day_${day}`;
  const timeField = `checked_in_day_${day}_at`;

  const ticket = await tickets.findOneAndUpdate(
    { _id: ticketId, [statusField]: { $ne: 'checked_in' } },
    { $set: { [statusField]: 'checked_in', [timeField]: new Date() } },
    { returnDocument: 'after' }
  );

  if (ticket) {
    return {
      status: 200,
      success: true,
      message: `${ticket.primary_name} checked in for Day ${day}`,
      ticket: publicTicket(ticket),
    };
  }

  const existing = await tickets.findOne({ _id: ticketId });
  if (!existing) {
    return { status: 404, success: false, message: 'Ticket not found. It may be fake or mistyped.' };
  }

  const at = existing[timeField];
  return {
    status: 409,
    success: false,
    message: at
      ? `Already checked in for Day ${day} at ${new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      : `Already checked in for Day ${day}`,
    ticket: publicTicket(existing),
  };
}

const publicTicket = (t) => ({
  id: t._id,
  event: t.event,
  name: t.primary_name,
  email: t.email,
  status_day_1: t.status_day_1 || 'pending',
  status_day_2: t.status_day_2 || 'pending',
});

module.exports = {
  chargeFor,
  newTicketId,
  ensureTicketIndexes,
  findEvent,
  createTicket,
  checkInTicket,
};
