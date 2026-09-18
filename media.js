const express = require('express');
const { GridFSBucket, ObjectId } = require('mongodb');
const { getDb } = require('./database');

/* =====================================================
   MEDIA STORAGE (MongoDB GridFS)
   Images uploaded from the admin panel live in the same
   database as everything else, so no extra hosting is needed.
   ===================================================== */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const bucket = () => new GridFSBucket(getDb(), { bucketName: 'media' });

const toObjectId = (id) => {
  if (typeof id !== 'string' || !ObjectId.isValid(id) || String(new ObjectId(id)) !== id) {
    return null;
  }
  return new ObjectId(id);
};

// Trust the file's bytes, not the Content-Type header, so nothing but a real
// image (e.g. an HTML or SVG file) can ever be served back from this origin.
function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function saveImage(buffer, filename = 'upload') {
  const contentType = sniffImageType(buffer);
  if (!contentType) {
    const err = new Error('Only JPG, PNG or WEBP images are allowed');
    err.status = 400;
    throw err;
  }

  return new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(filename, {
      metadata: { contentType, uploadedAt: new Date() },
    });
    upload.once('error', reject);
    upload.once('finish', () => resolve(String(upload.id)));
    upload.end(buffer);
  });
}

async function deleteMedia(id) {
  const oid = toObjectId(id);
  if (!oid) return;
  try {
    await bucket().delete(oid);
  } catch (err) {
    // Already gone is fine; anything else is worth knowing about.
    if (!/FileNotFound/i.test(String(err && err.message))) {
      console.error('Media delete error:', err);
    }
  }
}

function mediaRouter(requireAdminLogin) {
  const router = express.Router();

  /* ================= UPLOAD (ADMIN) ================= */
  router.post(
    '/api/media',
    requireAdminLogin,
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ success: false, message: 'No image received' });
        }
        const name = String(req.get('x-filename') || 'upload').slice(0, 120);
        const id = await saveImage(req.body, name);
        return res.json({ success: true, id });
      } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('Media upload error:', err);
        return res.status(500).json({ success: false, message: 'Upload failed' });
      }
    }
  );

  /* ================= SERVE (PUBLIC) ================= */
  router.get('/api/media/:id', async (req, res) => {
    const oid = toObjectId(req.params.id);
    if (!oid) return res.status(404).end();

    try {
      const file = await getDb().collection('media.files').findOne({ _id: oid });
      if (!file) return res.status(404).end();

      const etag = `"${req.params.id}"`;
      res.set({
        'Content-Type': file.metadata?.contentType || 'application/octet-stream',
        'Content-Length': String(file.length),
        // Ids are never reused, so a file's content never changes.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        ETag: etag,
      });
      if (req.get('if-none-match') === etag) return res.status(304).end();

      bucket()
        .openDownloadStream(oid)
        .once('error', (err) => {
          console.error('Media stream error:', err);
          if (!res.headersSent) res.status(500);
          res.end();
        })
        .pipe(res);
    } catch (err) {
      console.error('Media fetch error:', err);
      res.status(500).end();
    }
  });

  return router;
}

module.exports = { mediaRouter, saveImage, deleteMedia, toObjectId, sniffImageType };
