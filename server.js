const express    = require('express');
const multer     = require('multer');
const cors       = require('cors');
const path       = require('path');
const archiver   = require('archiver');
const unzipper   = require('unzipper');
const { MongoClient, ObjectId } = require('mongodb');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CLOUDINARY CONFIG ─────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── MONGODB ───────────────────────────────────────────────────────
let db;
async function connectDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('artwork_manager');
  console.log('  ✅  MongoDB connected');
}

function products() { return db.collection('products'); }

// ── MULTER (memory — files go straight to Cloudinary) ─────────────
const upload       = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

// ── CLOUDINARY HELPERS ────────────────────────────────────────────
function uploadToCloudinary(buffer, originalName, folder) {
  return new Promise((resolve, reject) => {
    const ext        = path.extname(originalName).toLowerCase();
    const isImage    = ['.png','.jpg','.jpeg','.svg','.webp','.gif'].includes(ext);
    const isPDF      = ext === '.pdf';
    const resourceType = (isImage || isPDF) ? 'auto' : 'raw';

    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType, use_filename: true, unique_filename: true },
      (err, result) => {
        if (err) return reject(err);
        resolve({
          originalName,
          publicId:     result.public_id,
          url:          result.secure_url,
          resourceType: result.resource_type,
          format:       result.format,
          size:         result.bytes,
        });
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

function deleteFromCloudinary(publicId, resourceType) {
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType || 'image' })
    .catch(err => console.warn('Cloudinary delete warning:', err.message));
}

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SERIALIZE product for API response ───────────────────────────
function serialize(p) {
  return {
    id:       p._id.toString(),
    name:     p.name,
    brand:    p.brand    || '',
    sourced:  p.sourced  || '',
    files:    p.files    || [],
    refFiles: p.refFiles || [],
  };
}

// ── API ROUTES ────────────────────────────────────────────────────

// GET all products
app.get('/api/products', async (req, res) => {
  try {
    const list = await products().find({}).sort({ createdAt: -1 }).toArray();
    res.json(list.map(serialize));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST create product
app.post('/api/products', upload.array('files'), async (req, res) => {
  try {
    const files = await Promise.all(
      (req.files || []).map(f => uploadToCloudinary(f.buffer, f.originalname, 'artwork_manager/artwork'))
    );
    const doc = {
      name:      req.body.name    || '',
      brand:     req.body.brand   || '',
      sourced:   req.body.sourced || '',
      files,
      refFiles:  [],
      createdAt: new Date(),
    };
    const result = await products().insertOne(doc);
    doc._id = result.insertedId;
    res.json(serialize(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT update product
app.put('/api/products/:id', upload.array('newFiles'), async (req, res) => {
  try {
    const p = await products().findOne({ _id: new ObjectId(req.params.id) });
    if (!p) return res.status(404).json({ error: 'Not found' });

    let keepIds = [];
    try { keepIds = JSON.parse(req.body.keepFiles || '[]'); } catch {}

    // Delete removed artwork files from Cloudinary
    const toDelete = p.files.filter(f => !keepIds.includes(f.publicId));
    await Promise.all(toDelete.map(f => deleteFromCloudinary(f.publicId, f.resourceType)));

    const keptFiles = p.files.filter(f => keepIds.includes(f.publicId));
    const newFiles  = await Promise.all(
      (req.files || []).map(f => uploadToCloudinary(f.buffer, f.originalname, 'artwork_manager/artwork'))
    );

    await products().updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: {
          name:    req.body.name    || p.name,
          brand:   req.body.brand   || '',
          sourced: req.body.sourced !== undefined ? req.body.sourced : (p.sourced || ''),
          files:   [...keptFiles, ...newFiles],
      }}
    );
    const updated = await products().findOne({ _id: new ObjectId(req.params.id) });
    res.json(serialize(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE product (+ all Cloudinary files)
app.delete('/api/products/:id', async (req, res) => {
  try {
    const p = await products().findOne({ _id: new ObjectId(req.params.id) });
    if (!p) return res.status(404).json({ error: 'Not found' });
    await Promise.all([
      ...(p.files    || []).map(f => deleteFromCloudinary(f.publicId, f.resourceType)),
      ...(p.refFiles || []).map(f => deleteFromCloudinary(f.publicId, f.resourceType)),
    ]);
    await products().deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE single artwork file
app.delete('/api/products/:id/files/:publicId(*)', async (req, res) => {
  try {
    const p = await products().findOne({ _id: new ObjectId(req.params.id) });
    if (!p) return res.status(404).json({ error: 'Not found' });
    const file = p.files.find(f => f.publicId === req.params.publicId);
    if (file) await deleteFromCloudinary(file.publicId, file.resourceType);
    await products().updateOne(
      { _id: new ObjectId(req.params.id) },
      { $pull: { files: { publicId: req.params.publicId } } }
    );
    const updated = await products().findOne({ _id: new ObjectId(req.params.id) });
    res.json(serialize(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST add reference files
app.post('/api/products/:id/refs', upload.array('refFiles'), async (req, res) => {
  try {
    const p = await products().findOne({ _id: new ObjectId(req.params.id) });
    if (!p) return res.status(404).json({ error: 'Not found' });
    const newRefs = await Promise.all(
      (req.files || []).map(f => uploadToCloudinary(f.buffer, f.originalname, 'artwork_manager/refs'))
    );
    await products().updateOne(
      { _id: new ObjectId(req.params.id) },
      { $push: { refFiles: { $each: newRefs } } }
    );
    const updated = await products().findOne({ _id: new ObjectId(req.params.id) });
    res.json(serialize(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE single reference file
app.delete('/api/products/:id/refs/:publicId(*)', async (req, res) => {
  try {
    const p = await products().findOne({ _id: new ObjectId(req.params.id) });
    if (!p) return res.status(404).json({ error: 'Not found' });
    const file = (p.refFiles || []).find(f => f.publicId === req.params.publicId);
    if (file) await deleteFromCloudinary(file.publicId, file.resourceType);
    await products().updateOne(
      { _id: new ObjectId(req.params.id) },
      { $pull: { refFiles: { publicId: req.params.publicId } } }
    );
    const updated = await products().findOne({ _id: new ObjectId(req.params.id) });
    res.json(serialize(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EXPORT — zip of metadata JSON (Cloudinary URLs preserved) ─────
app.get('/api/export', async (req, res) => {
  try {
    const list = await products().find({}).toArray();
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="artwork-manager-backup-' + ts + '.zip"');
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => console.error('Export error:', err));
    archive.pipe(res);
    archive.append(JSON.stringify({ products: list.map(serialize) }, null, 2), { name: 'products.json' });
    archive.finalize();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── IMPORT — restore from backup zip ─────────────────────────────
app.post('/api/import', importUpload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const zip = await unzipper.Open.buffer(req.file.buffer);
    let importedData = null;
    for (const entry of zip.files) {
      if (entry.path === 'products.json') {
        importedData = JSON.parse((await entry.buffer()).toString('utf8'));
      }
    }
    if (!importedData || !Array.isArray(importedData.products)) {
      return res.status(400).json({ error: 'Invalid backup: missing products.json' });
    }

    const mode = req.query.mode || 'replace';
    if (mode === 'replace') {
      // Note: Cloudinary files are preserved (URLs still valid) — only DB records cleared
      await products().deleteMany({});
    }

    const docs = importedData.products.map(p => ({
      name:      p.name     || '',
      brand:     p.brand    || '',
      sourced:   p.sourced  || '',
      files:     p.files    || [],
      refFiles:  p.refFiles || [],
      createdAt: new Date(),
    }));
    if (docs.length > 0) await products().insertMany(docs);
    res.json({ ok: true, productCount: await products().countDocuments() });
  } catch (e) { res.status(500).json({ error: 'Import failed: ' + e.message }); }
});

// ── START ─────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('  ✅  Product Manager → http://localhost:' + PORT);
    console.log('  ☁️   Files: Cloudinary  |  Data: MongoDB Atlas');
    console.log('');
  });
}).catch(err => {
  console.error('❌  MongoDB connection failed:', err.message);
  process.exit(1);
});