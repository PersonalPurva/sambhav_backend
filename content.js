const express = require('express');
const crypto = require('crypto');
const { getDb } = require('./database');
const { deleteMedia, toObjectId } = require('./media');

/* =====================================================
   SITE CONTENT: events, team, gallery, site settings
   Everything the website shows that admins should be able
   to change without touching code.
   ===================================================== */

const TEAM_TIERS = ['founder', 'council', 'heads', 'coheads'];
const GALLERY_CATEGORIES = ['events', 'workshops', 'community', 'team'];
const EVENT_CATEGORIES = ['financial', 'entrepreneurship', 'social', 'mental-health', 'innovation'];
const FORM_FIELD_TYPES = ['text', 'email', 'number', 'phone', 'date', 'textarea', 'dropdown'];

const DEFAULT_SITE = {
  contact: {
    phone: '+91 8766634613',
    email: 'sambhav.team.official@gmail.com',
    address: "JSPM's RSCOE, Common Room, Tathawade, Pune 411033",
  },
  socials: {
    instagram: 'https://www.instagram.com/sambhav.official',
    twitter: 'https://x.com/Sambhav_Youth',
    linkedin: 'https://www.linkedin.com/company/sambhav-club',
  },
  stats: [
    { value: '10,000+', label: 'Lives Impacted' },
    { value: '150+', label: 'Events Hosted' },
    { value: '500+', label: 'Active Members' },
    { value: '50+', label: 'Partner Organizations' },
  ],
  heroSlides: [],
};

/* ================= VALIDATION HELPERS ================= */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const text = (value, field, { max = 200, required = false } = {}) => {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidationError(`${field} must be text`);
  }
  const out = String(value).trim();
  if (required && !out) throw new ValidationError(`${field} is required`);
  if (out.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return out;
};

const oneOf = (value, field, allowed) => {
  if (!allowed.includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
};

const mediaId = (value, field, { required = false } = {}) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return null;
  }
  if (!toObjectId(value)) throw new ValidationError(`${field} is not a valid image`);
  return value;
};

const number = (value, field, { min = 0, max = 1e7 } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be a number between ${min} and ${max}`);
  }
  return n;
};

// Links rendered into <a href>. Only site-relative paths and https URLs,
// so a stored value can never become a javascript: link.
const link = (value, field, { allowRelative = true } = {}) => {
  const out = text(value, field, { max: 500 });
  if (!out) return '';
  if (allowRelative && out.startsWith('/') && !out.startsWith('//')) return out;
  try {
    const url = new URL(out);
    if (url.protocol === 'https:') return out;
  } catch {}
  throw new ValidationError(
    allowRelative ? `${field} must start with / or https://` : `${field} must start with https://`
  );
};

const list = (value, field, max) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be a list`);
  if (value.length > max) throw new ValidationError(`${field} can have at most ${max} items`);
  return value;
};

const idsList = (value) => {
  const ids = list(value, 'ids', 500);
  const oids = ids.map((id) => toObjectId(id));
  if (oids.some((oid) => !oid)) throw new ValidationError('ids contains an invalid id');
  return oids;
};

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error(`${req.method} ${req.path} error:`, err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

const notFound = (res, what) => res.status(404).json({ success: false, message: `${what} not found` });

/* ================= EVENTS ================= */

function cleanFormFields(value) {
  return list(value, 'formFields', 40).map((f, i) => {
    const type = oneOf(f?.type, `formFields[${i}].type`, FORM_FIELD_TYPES);
    const field = {
      id: text(f.id, `formFields[${i}].id`, { max: 60, required: true }),
      label: text(f.label, `formFields[${i}].label`, { max: 120, required: true }),
      type,
      required: Boolean(f.required),
    };
    if (f.placeholder) field.placeholder = text(f.placeholder, `formFields[${i}].placeholder`, { max: 200 });
    if (type === 'dropdown') {
      field.options = list(f.options, `formFields[${i}].options`, 50).map((o, j) =>
        text(o, `formFields[${i}].options[${j}]`, { max: 120, required: true })
      );
    }
    return field;
  });
}

// Accepts a full event (create) or a partial one (update).
function cleanEvent(body, { partial }) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;

  if (has('title')) out.title = text(body.title, 'Title', { max: 150, required: true });
  if (has('shortDescription')) out.shortDescription = text(body.shortDescription, 'Short description', { max: 300 });
  if (has('description')) out.description = text(body.description, 'Description', { max: 10000 });
  if (has('date')) out.date = text(body.date, 'Date', { max: 40 });
  if (has('time')) out.time = text(body.time, 'Time', { max: 40 });
  if (has('location')) out.location = text(body.location, 'Location', { max: 200 });
  if (has('ticketPrice')) out.ticketPrice = number(body.ticketPrice ?? 0, 'Ticket price', { max: 100000 });
  if (has('maxAttendees')) out.maxAttendees = number(body.maxAttendees ?? 0, 'Max attendees', { max: 1000000 });
  if (has('category')) out.category = oneOf(body.category, 'Category', EVENT_CATEGORIES);
  if (has('status')) out.status = text(body.status || 'upcoming', 'Status', { max: 30 });
  if (has('formFields')) out.formFields = cleanFormFields(body.formFields);
  if (has('ruleBookUrl')) out.ruleBookUrl = link(body.ruleBookUrl, 'Rule book link', { allowRelative: false });
  if (has('imageId')) out.imageId = mediaId(body.imageId, 'Event image');
  // Legacy: filename of an image bundled in the frontend's /assets/events.
  if (has('image')) out.image = text(body.image, 'Image filename', { max: 200 });

  return out;
}

// Events created by hand in the database may not have an `id` field,
// so they are addressable by their Mongo _id as well.
const eventFilter = (id) => {
  const oid = toObjectId(id);
  return oid ? { $or: [{ id }, { _id: oid }] } : { id };
};

const eventOut = (e) => ({ ...e, id: e.id || String(e._id) });

/* ================= TEAM ================= */

const teamOut = (m) => ({
  id: String(m._id),
  name: m.name,
  role: m.role,
  tier: m.tier,
  photoId: m.photoId || null,
  order: m.order ?? 0,
});

function cleanTeamMember(body, { partial }) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (has('name')) out.name = text(body.name, 'Name', { max: 100, required: true });
  if (has('role')) out.role = text(body.role, 'Role', { max: 120, required: true });
  if (has('tier')) out.tier = oneOf(body.tier, 'Tier', TEAM_TIERS);
  if (has('photoId')) out.photoId = mediaId(body.photoId, 'Photo');
  return out;
}

/* ================= GALLERY ================= */

const galleryOut = (g) => ({
  id: String(g._id),
  imageId: g.imageId,
  caption: g.caption || '',
  category: g.category,
  order: g.order ?? 0,
});

function cleanGalleryImage(body, { partial }) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (!partial) out.imageId = mediaId(body.imageId, 'Image', { required: true });
  if (has('caption')) out.caption = text(body.caption, 'Caption', { max: 200 });
  if (has('category')) out.category = oneOf(body.category || 'events', 'Category', GALLERY_CATEGORIES);
  return out;
}

/* ================= SITE SETTINGS ================= */

function cleanSite(body) {
  const contact = body.contact || {};
  const socials = body.socials || {};

  const email = text(contact.email, 'Contact email', { max: 120 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError('Contact email is not a valid email address');
  }

  return {
    contact: {
      phone: text(contact.phone, 'Contact phone', { max: 30 }),
      email,
      address: text(contact.address, 'Address', { max: 300 }),
    },
    socials: {
      instagram: link(socials.instagram, 'Instagram link', { allowRelative: false }),
      twitter: link(socials.twitter, 'X / Twitter link', { allowRelative: false }),
      linkedin: link(socials.linkedin, 'LinkedIn link', { allowRelative: false }),
    },
    stats: list(body.stats, 'Stats', 8).map((s, i) => ({
      value: text(s?.value, `Stat ${i + 1} value`, { max: 30, required: true }),
      label: text(s?.label, `Stat ${i + 1} label`, { max: 60, required: true }),
    })),
    heroSlides: list(body.heroSlides, 'Hero slides', 10).map((s, i) => ({
      imageId: mediaId(s?.imageId, `Slide ${i + 1} image`, { required: true }),
      label: text(s?.label, `Slide ${i + 1} button text`, { max: 80 }),
      link: link(s?.link, `Slide ${i + 1} link`),
    })),
  };
}

async function getSite() {
  const doc = await getDb().collection('site_settings').findOne({ _id: 'site' });
  if (!doc) return DEFAULT_SITE;
  const { _id, updatedAt, ...site } = doc;
  return { ...DEFAULT_SITE, ...site };
}

/* ================= ORDERING ================= */

async function applyOrder(collection, oids) {
  if (oids.length === 0) return;
  await getDb()
    .collection(collection)
    .bulkWrite(
      oids.map((_id, order) => ({ updateOne: { filter: { _id }, update: { $set: { order } } } }))
    );
}

async function nextOrder(collection, filter = {}) {
  const last = await getDb().collection(collection).find(filter).sort({ order: -1 }).limit(1).next();
  return last ? (last.order ?? 0) + 1 : 0;
}

/* ================= ROUTES ================= */

function contentRouter(requireAdminLogin) {
  const router = express.Router();
  const admin = requireAdminLogin;

  /* ---------- Events ---------- */
  router.get('/api/events', handle(async (req, res) => {
    const events = await getDb().collection('events').find({}).sort({ date: 1 }).toArray();
    res.json({ success: true, events: events.map(eventOut) });
  }));

  router.post('/api/events', admin, handle(async (req, res) => {
    const event = {
      ...cleanEvent(req.body, { partial: false }),
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await getDb().collection('events').insertOne(event);
    res.json({ success: true, event });
  }));

  router.put('/api/events/:id', admin, handle(async (req, res) => {
    const update = cleanEvent(req.body, { partial: true });
    const events = getDb().collection('events');
    const before = await events.findOneAndUpdate(
      eventFilter(req.params.id),
      { $set: { ...update, updatedAt: new Date().toISOString() } },
      { returnDocument: 'before' }
    );
    if (!before) return notFound(res, 'Event');
    if (update.imageId !== undefined && before.imageId && before.imageId !== update.imageId) {
      await deleteMedia(before.imageId);
    }
    const event = await events.findOne({ _id: before._id });
    res.json({ success: true, event: eventOut(event) });
  }));

  router.delete('/api/events/:id', admin, handle(async (req, res) => {
    const deleted = await getDb().collection('events').findOneAndDelete(eventFilter(req.params.id));
    if (!deleted) return notFound(res, 'Event');
    if (deleted.imageId) await deleteMedia(deleted.imageId);
    // Tickets are deliberately kept: they are payment records.
    res.json({ success: true });
  }));

  /* ---------- Team ---------- */
  router.get('/api/team', handle(async (req, res) => {
    const members = await getDb().collection('team_members').find({}).sort({ order: 1, _id: 1 }).toArray();
    res.json({ success: true, members: members.map(teamOut) });
  }));

  router.post('/api/team', admin, handle(async (req, res) => {
    const member = cleanTeamMember(req.body, { partial: false });
    const doc = {
      ...member,
      order: await nextOrder('team_members', { tier: member.tier }),
      createdAt: new Date(),
    };
    const { insertedId } = await getDb().collection('team_members').insertOne(doc);
    res.json({ success: true, member: teamOut({ ...doc, _id: insertedId }) });
  }));

  // Must be registered before /api/team/:id.
  router.put('/api/team/order', admin, handle(async (req, res) => {
    await applyOrder('team_members', idsList(req.body.ids));
    res.json({ success: true });
  }));

  router.put('/api/team/:id', admin, handle(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) return notFound(res, 'Team member');
    const update = cleanTeamMember(req.body, { partial: true });
    const team = getDb().collection('team_members');
    const before = await team.findOneAndUpdate(
      { _id },
      { $set: { ...update, updatedAt: new Date() } },
      { returnDocument: 'before' }
    );
    if (!before) return notFound(res, 'Team member');
    if (update.photoId !== undefined && before.photoId && before.photoId !== update.photoId) {
      await deleteMedia(before.photoId);
    }
    res.json({ success: true, member: teamOut(await team.findOne({ _id })) });
  }));

  router.delete('/api/team/:id', admin, handle(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) return notFound(res, 'Team member');
    const deleted = await getDb().collection('team_members').findOneAndDelete({ _id });
    if (!deleted) return notFound(res, 'Team member');
    if (deleted.photoId) await deleteMedia(deleted.photoId);
    res.json({ success: true });
  }));

  /* ---------- Gallery ---------- */
  router.get('/api/gallery', handle(async (req, res) => {
    const images = await getDb().collection('gallery_images').find({}).sort({ order: 1, _id: 1 }).toArray();
    res.json({ success: true, images: images.map(galleryOut) });
  }));

  router.post('/api/gallery', admin, handle(async (req, res) => {
    const doc = {
      ...cleanGalleryImage(req.body, { partial: false }),
      order: await nextOrder('gallery_images'),
      createdAt: new Date(),
    };
    const { insertedId } = await getDb().collection('gallery_images').insertOne(doc);
    res.json({ success: true, image: galleryOut({ ...doc, _id: insertedId }) });
  }));

  router.put('/api/gallery/order', admin, handle(async (req, res) => {
    await applyOrder('gallery_images', idsList(req.body.ids));
    res.json({ success: true });
  }));

  router.put('/api/gallery/:id', admin, handle(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) return notFound(res, 'Image');
    const update = cleanGalleryImage(req.body, { partial: true });
    const gallery = getDb().collection('gallery_images');
    const result = await gallery.updateOne({ _id }, { $set: { ...update, updatedAt: new Date() } });
    if (result.matchedCount === 0) return notFound(res, 'Image');
    res.json({ success: true, image: galleryOut(await gallery.findOne({ _id })) });
  }));

  router.delete('/api/gallery/:id', admin, handle(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) return notFound(res, 'Image');
    const deleted = await getDb().collection('gallery_images').findOneAndDelete({ _id });
    if (!deleted) return notFound(res, 'Image');
    await deleteMedia(deleted.imageId);
    res.json({ success: true });
  }));

  /* ---------- Site settings ---------- */
  router.get('/api/site', handle(async (req, res) => {
    res.json({ success: true, site: await getSite() });
  }));

  router.put('/api/site', admin, handle(async (req, res) => {
    const site = cleanSite(req.body);
    const before = await getSite();
    await getDb()
      .collection('site_settings')
      .updateOne({ _id: 'site' }, { $set: { ...site, updatedAt: new Date() } }, { upsert: true });

    const kept = new Set(site.heroSlides.map((s) => s.imageId));
    for (const slide of before.heroSlides || []) {
      if (slide.imageId && !kept.has(slide.imageId)) await deleteMedia(slide.imageId);
    }
    res.json({ success: true, site });
  }));

  return router;
}

module.exports = {
  contentRouter,
  eventFilter,
  eventOut,
  TEAM_TIERS,
  GALLERY_CATEGORIES,
  DEFAULT_SITE,
};
