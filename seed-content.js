/* =====================================================
   ONE-TIME CONTENT IMPORT
   Copies the team, gallery and homepage content that used to be
   hardcoded in the frontend into the database, so the website looks
   exactly the same after switching to the admin panel.

   Usage:
     node seed-content.js <path-to-frontend-folder>

   Safe to run again: each section is skipped if it already has data.
   ===================================================== */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { connectToDatabase, getDb } = require('./database');
const { saveImage } = require('./media');
const { DEFAULT_SITE } = require('./content');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  console.warn('⚠️  "sharp" is not installed, so images are stored at full size. Run: npm install --no-save sharp');
}

const TEAM = [
  ['Vikram Khade', 'Founder President', 'founder', 'vikram khade.jpg'],
  ['Adityaraj Kshetre', 'President', 'council', 'Adityaraj Kshetre.jpg'],
  ['Sharvan Koul', 'Vice President', 'council', 'sharvan koul.jpeg'],
  ['Shivanand Potle', 'Secretary', 'council', 'shivanand-potle.jpg'],
  ['Ranjeet', 'Joint Secretary', 'council', 'Ranjeet.jpeg'],
  ['Shreyash Mangale', 'Treasurer', 'council', 'Shreyash Mangale.jpeg'],
  ['Tanishka Bellale', 'Graphics Design Head', 'heads', 'tanishka.jpeg'],
  ['Ishanvi Gawade', 'Polytechnic Head', 'heads', 'ishanvi.jpeg'],
  ['Aditya', 'Event Management Head', 'heads', 'Aditya.jpeg'],
  ['Purva Kadam', 'Technical Operations Head', 'heads', 'purva.jpeg'],
  ['Vedika Palve', 'PR Head', 'heads', 'vedika.jpg'],
  ['Aditya Dolchipure', 'Media Production Head', 'heads', 'Aditya dolchipure.jpg'],
  ['Prathmesh Shinde', 'Membership Director', 'heads', 'prathmesh.png'],
  ['Komal Patil', 'Student Relations Director', 'heads', 'komal.jpeg'],
  ['Janhavi Wankhade', 'Club Service Director', 'heads', 'janhavi.jpg'],
  ['Aaditi Metkari', 'Mechanical Department Head', 'heads', 'aaditi metkari.jpeg'],
  ['Diksha Dhembre', 'CS Department Head', 'heads', 'diksha.jpeg'],
  ['Eshika Swami', 'IT Department Head & Associate PR Officer', 'heads', 'eshika.jpeg'],
  ['Tanishka Gawale', 'Graphics Co-Head', 'coheads', 'Tanishka Gawale.jpg'],
  ['Aditi Bhupatwar', 'Technical Co-Head', 'coheads', 'aditi.jpeg'],
  ['Virendra Khade', 'Event Co-Head', 'coheads', 'Virendra Khade.jpg'],
  ['Viraj Chandekar', 'Media Production Manager', 'coheads', 'Viraj.jpg'],
  ['Hardik Jain', 'Associate Club Service Director', 'coheads', 'hardik.jpeg'],
];

const GALLERY = [
  'aarambh.jpg', 'aarambh2.JPG', 'aarambh3.JPG', 'aarambh4.JPG', 'bgmitour.JPG',
  'foundationday.jpg', 'inspirex6.JPG', 'inspirex7.JPG', 'installation1.jpg', 'ndavisit2.jpg',
  'sahara1.JPG', 'sahara2.JPG', 'sahara3.JPG', 'sahara4.JPG', 'traditionalday.jpg',
];

const HERO_SLIDES = [
  ['src/assets/avinya.jpeg', 'Register for Avinya 4.0', '/events#entrepreneurship'],
  ['src/assets/heroimg6.jpeg', 'Register for Aarambh', '/events#financial-literacy'],
];

// Same caption logic the gallery page used for filenames.
const captionFromFilename = (filename) =>
  filename
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]/g, ' ')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

async function uploadFile(filePath, maxDimension) {
  if (!fs.existsSync(filePath)) {
    console.warn(`   ⚠️  Missing file, skipped: ${filePath}`);
    return null;
  }
  let buffer = fs.readFileSync(filePath);
  if (sharp) {
    buffer = await sharp(buffer)
      .rotate() // respect phone camera orientation
      .flatten({ background: '#ffffff' }) // transparent PNGs would otherwise turn black
      .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  }
  return saveImage(buffer, path.basename(filePath));
}

async function seedTeam(frontend) {
  const team = getDb().collection('team_members');
  if (await team.countDocuments()) return console.log('👥 Team already has data, skipped');

  console.log('👥 Importing team...');
  const order = {};
  for (const [name, role, tier, file] of TEAM) {
    const photoId = await uploadFile(path.join(frontend, 'public/assets/team', file), 800);
    order[tier] = (order[tier] ?? -1) + 1;
    await team.insertOne({ name, role, tier, photoId, order: order[tier], createdAt: new Date() });
    console.log(`   ✔ ${name}`);
  }
}

async function seedGallery(frontend) {
  const gallery = getDb().collection('gallery_images');
  if (await gallery.countDocuments()) return console.log('🖼️  Gallery already has data, skipped');

  console.log('🖼️  Importing gallery...');
  let order = 0;
  for (const file of GALLERY) {
    const imageId = await uploadFile(path.join(frontend, 'public/assets/gallery', file), 1600);
    if (!imageId) continue;
    await gallery.insertOne({
      imageId,
      caption: captionFromFilename(file),
      category: 'events',
      order: order++,
      createdAt: new Date(),
    });
    console.log(`   ✔ ${file}`);
  }
}

async function seedSite(frontend) {
  const settings = getDb().collection('site_settings');
  if (await settings.findOne({ _id: 'site' })) return console.log('🏠 Site settings already exist, skipped');

  console.log('🏠 Importing homepage slides and contact details...');
  const heroSlides = [];
  for (const [file, label, link] of HERO_SLIDES) {
    const imageId = await uploadFile(path.join(frontend, file), 1920);
    if (imageId) heroSlides.push({ imageId, label, link });
  }
  await settings.insertOne({ _id: 'site', ...DEFAULT_SITE, heroSlides, updatedAt: new Date() });
}

async function main() {
  const frontend = process.argv[2];
  if (!frontend || !fs.existsSync(path.join(frontend, 'public/assets'))) {
    console.error('Usage: node seed-content.js <path-to-frontend-folder>');
    process.exit(1);
  }

  await connectToDatabase();
  await seedTeam(frontend);
  await seedGallery(frontend);
  await seedSite(frontend);
  console.log('✅ Content import finished');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Import failed:', err);
  process.exit(1);
});
