require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const { ObjectId } = require('mongodb');

const { connectToDatabase, getDb } = require('./database');
const { mediaRouter } = require('./media');
const { contentRouter } = require('./content');
const {
  chargeFor,
  ensureTicketIndexes,
  findEvent,
  createTicket,
  checkInTicket,
} = require('./tickets');

const app = express();
const PORT = process.env.PORT || 5000;

/* ================= RAZORPAY ================= */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ================= CORS ================= */
app.use(cors({
  origin: [
    'http://localhost:8080',
    'https://sambhavofficial.in',
    'https://www.sambhavofficial.in',
    'https://sambhav-frontend.onrender.com',
    // Extra sites (e.g. a test deployment), comma-separated.
    ...(process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
  ],
  credentials: true
}));

const toObjectId = (id) => (typeof id === 'string' && ObjectId.isValid(id) ? new ObjectId(id) : null);

const markPreRegistrationDone = async (preRegId) => {
  const _id = toObjectId(preRegId);
  if (!_id) return;
  await getDb().collection('pre_registrations').updateOne({ _id }, { $set: { status: 'completed' } });
};

/* =====================================================
   🔥 RAZORPAY WEBHOOK (MUST BE BEFORE express.json)
   ===================================================== */
app.post(
  '/api/razorpay-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      console.log('🔥 Razorpay webhook HIT');
      const signature = String(req.headers['x-razorpay-signature'] || '');

      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(req.body)
        .digest('hex');

      if (!safeEqual(signature, expectedSignature)) {
        console.error('❌ Invalid webhook signature');
        return res.status(400).send('Invalid signature');
      }
      console.log('✅ Razorpay webhook signature verified');

      const payload = JSON.parse(req.body.toString());
      console.log('📦 Webhook event:', payload.event);

      if (payload.event === 'payment.captured') {
        const payment = payload.payload.payment.entity;
        const notes = payment.notes || {};
        console.log('💰 Payment captured:', payment.id);

        const event = await findEvent({ eventId: notes.eventId, eventTitle: notes.eventTitle });
        if (!event) {
          console.error('❌ Webhook: event not found for payment', payment.id, notes);
          // 200 so Razorpay does not retry forever; this needs a human.
          return res.json({ status: 'event_not_found' });
        }

        const preReg = await findPreRegistration(notes, event);
        const { created } = await createTicket({
          event,
          name: notes.name,
          email: notes.email,
          formData: preReg?.formData,
          paymentId: payment.id,
        });
        if (preReg) await markPreRegistrationDone(String(preReg._id));
        console.log(created ? '🎟️  Ticket created by webhook' : 'ℹ️  Ticket already existed');
      }

      return res.json({ status: 'ok' });
    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(500).send('Webhook error');
    }
  }
);

async function findPreRegistration(notes, event) {
  const preRegs = getDb().collection('pre_registrations');
  const _id = toObjectId(notes.preRegId);
  if (_id) return preRegs.findOne({ _id });
  // Orders created before preRegId was stored in the notes.
  return preRegs.findOne(
    { email: notes.email, event: event.title, status: 'pending_payment' },
    { sort: { createdAt: -1 } }
  );
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ================= JSON PARSER (AFTER WEBHOOK) ================= */
app.use(express.json({ limit: '1mb' }));

/* ================= SESSION ================= */
// Production serves the frontend and API from different sites, which needs
// Secure + SameSite=None cookies. For local development over plain http,
// set SESSION_COOKIE_SECURE=false in .env.
const secureCookies = process.env.SESSION_COOKIE_SECURE !== 'false';

app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'sambhav-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: secureCookies,
    httpOnly: true,
    sameSite: secureCookies ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const requireAdminLogin = (req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Unauthorized' });
};

/* ================= ADMIN AUTH ================= */
app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ authenticated: true, user: req.session.user });
  }
  res.status(401).json({ authenticated: false });
});

// Simple in-memory brute-force guard: 10 failed attempts per IP per 15 minutes.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map();

app.post('/api/login', (req, res) => {
  const now = Date.now();
  const entry = loginFailures.get(req.ip);
  if (entry && entry.resetAt > now && entry.count >= LOGIN_MAX_FAILURES) {
    return res.status(429).json({
      success: false,
      message: 'Too many failed attempts. Try again in 15 minutes.',
    });
  }

  const { username, password } = req.body || {};
  const configured = Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD);
  const valid =
    configured &&
    typeof username === 'string' &&
    typeof password === 'string' &&
    safeEqual(username, process.env.ADMIN_USERNAME) &&
    safeEqual(password, process.env.ADMIN_PASSWORD);

  if (!valid) {
    const fresh = !entry || entry.resetAt <= now;
    loginFailures.set(req.ip, {
      count: fresh ? 1 : entry.count + 1,
      resetAt: fresh ? now + LOGIN_WINDOW_MS : entry.resetAt,
    });
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  loginFailures.delete(req.ip);
  // New session id on login, so a pre-login session id cannot be reused.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ success: false, message: 'Login failed' });
    req.session.user = { id: 'admin', role: 'admin' };
    return res.json({ success: true, user: req.session.user });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

/* ================= CONTENT: EVENTS, TEAM, GALLERY, SITE, MEDIA ================= */
app.use(mediaRouter(requireAdminLogin));
app.use(contentRouter(requireAdminLogin));

/* ================= REGISTRATIONS (ADMIN) ================= */
app.get('/api/registrations', requireAdminLogin, async (req, res) => {
  try {
    const tickets = await getDb()
      .collection('tickets')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, data: tickets });
  } catch (err) {
    console.error('Registrations error:', err);
    res.status(500).json({ success: false });
  }
});

/* ================= TICKET CHECK-IN (ADMIN / SCANNER) ================= */
app.post('/api/validate-ticket/:ticketId', requireAdminLogin, async (req, res) => {
  try {
    const { status, ...result } = await checkInTicket(req.params.ticketId, req.query.day);
    res.status(status).json(result);
  } catch (err) {
    console.error('Validate ticket error:', err);
    res.status(500).json({ success: false, message: 'Server error while checking ticket' });
  }
});

/* ================= PRE-REGISTER (SAVE FORM DATA BEFORE PAYMENT) ================= */
app.post('/api/pre-register', async (req, res) => {
  try {
    const { eventId, eventTitle, name, email, formData } = req.body;

    if (!email || !(eventId || eventTitle)) {
      return res.status(400).json({ success: false, message: 'Email and event are required' });
    }

    const event = await findEvent({ eventId, eventTitle });
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    const { insertedId } = await getDb().collection('pre_registrations').insertOne({
      event: event.title,
      eventId: event.id || String(event._id),
      primary_name: name,
      email,
      formData,
      status: 'pending_payment',
      createdAt: new Date(),
    });

    return res.json({ success: true, preId: String(insertedId) });
  } catch (err) {
    console.error('Pre-register error:', err);
    return res.status(500).json({ success: false });
  }
});

/* ================= CREATE ORDER ================= */
app.post('/api/create-order', async (req, res) => {
  try {
    const { eventId, eventTitle, name, email, preId } = req.body;

    // The price always comes from the database, never from the browser,
    // so nobody can buy a ticket for less by editing the request.
    const event = await findEvent({ eventId, eventTitle });
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    if (!(Number(event.ticketPrice) > 0)) {
      return res.status(400).json({ success: false, message: 'This event is free; no payment needed' });
    }

    const amount = chargeFor(event.ticketPrice);
    const note = (v) => String(v ?? '').slice(0, 250);

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: 'INR',
      payment_capture: 1,
      receipt: `rcpt_${Date.now()}`,
      notes: {
        name: note(name),
        email: note(email),
        eventTitle: note(event.title),
        eventId: note(event.id || String(event._id)),
        preRegId: note(preId),
      }
    });

    return res.json({ success: true, order, amount });
  } catch (err) {
    console.error('Order error:', err);
    return res.status(500).json({ success: false });
  }
});

/* ================= VERIFY PAYMENT (FRONTEND) ================= */
app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      formData
    } = req.body;

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (!safeEqual(razorpay_signature || '', expectedSignature)) {
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const existing = await getDb()
      .collection('tickets')
      .findOne({ payment_id: razorpay_payment_id });
    if (existing) {
      return res.json({ success: true, ticketId: existing._id });
    }

    // Who paid and for what comes from the order the server created,
    // not from the request body.
    const order = await razorpay.orders.fetch(razorpay_order_id);
    const notes = order.notes || {};
    const event = await findEvent({ eventId: notes.eventId, eventTitle: notes.eventTitle });
    if (!event) {
      console.error('❌ Verify: event not found for order', razorpay_order_id, notes);
      return res.status(404).json({ success: false, message: 'Event not found. Please contact support.' });
    }

    const preReg = await findPreRegistration(notes, event);
    const { ticket } = await createTicket({
      event,
      name: notes.name,
      email: notes.email,
      formData: preReg?.formData || formData,
      paymentId: razorpay_payment_id,
    });
    if (preReg) await markPreRegistrationDone(String(preReg._id));

    return res.json({ success: true, ticketId: ticket._id });

  } catch (err) {
    console.error('Verify error:', err);
    return res.status(500).json({ success: false });
  }
});

/* ================= FREE EVENT REGISTRATION ================= */
app.post('/api/register-free', async (req, res) => {
  try {
    const { eventId, name, formData } = req.body;
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !eventId) {
      return res.status(400).json({ success: false, message: 'Email and event are required' });
    }

    const event = await findEvent({ eventId });
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    if (Number(event.ticketPrice) > 0) {
      return res.status(400).json({ success: false, message: 'This event requires payment' });
    }

    // Registering twice returns the same ticket instead of a new one.
    const existing = await getDb().collection('tickets').findOne({
      eventId: event.id || String(event._id),
      email,
    });
    if (existing) {
      return res.json({ success: true, ticketId: existing._id, alreadyRegistered: true });
    }

    const { ticket } = await createTicket({ event, name, email, formData });
    return res.json({ success: true, ticketId: ticket._id });
  } catch (err) {
    console.error('Free registration error:', err);
    return res.status(500).json({ success: false });
  }
});

/* ================= START ================= */
connectToDatabase()
  .then(ensureTicketIndexes)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  });
