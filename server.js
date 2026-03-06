const express     = require('express');
const multer      = require('multer');
const cors        = require('cors');
const path        = require('path');
const fs          = require('fs');
const archiver    = require('archiver');
const unzipper    = require('unzipper');
const cloudinary  = require('cloudinary').v2;
const streamifier = require('streamifier');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CLOUDINARY CONFIG ─────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── DATA DIR — uses Railway volume if available, else local ───────
// In Railway: add a Volume mounted at /data in your service settings
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'products.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── JSON DATABASE ─────────────────────────────────────────────────
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { products: [] }; }
}
function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('  💾  Saved', (data.products || []).length, 'products to', DB_FILE);
  } catch(e) {
    console.error('writeDB error:', e.message, '| DB_FILE:', DB_FILE);
    throw e;
  }
}

// ── MULTER (memory — files go to Cloudinary) ──────────────────────
const upload       = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

// ── CLOUDINARY HELPERS ────────────────────────────────────────────
function uploadToCloudinary(buffer, originalName, folder) {
  return new Promise((resolve, reject) => {
    const safeName     = originalName || 'unnamed_file';
    const ext          = path.extname(safeName).toLowerCase();
    const nameNoExt    = path.basename(safeName, ext);
    const isImage      = ['.png','.jpg','.jpeg','.svg','.webp','.gif'].includes(ext);
    // PDFs and everything else go as raw — never use 'auto' for PDFs
    // because Cloudinary stores them under /image/upload/ which breaks downloads
    const resourceType = isImage ? 'image' : 'raw';

    // Sanitize filename for Cloudinary public_id — remove all special chars
    const uniqueSuffix  = Date.now() + '_' + Math.round(Math.random() * 1e4);
    const safeNameNoExt = nameNoExt.replace(/[^a-zA-Z0-9_-]/g, '_');
    const forcedPublicId = folder + '/' + safeNameNoExt + '_' + uniqueSuffix;

    const stream = cloudinary.uploader.upload_stream(
      {
        public_id:       forcedPublicId,
        resource_type:   resourceType,
        // Do NOT use use_filename/unique_filename when setting public_id manually
        overwrite:       false,
      },
      (err, result) => {
        if (err) {
          console.error('Cloudinary upload error for', safeName, ':', err.message);
          return reject(new Error('Upload failed for ' + safeName + ': ' + err.message));
        }
        if (!result || !result.public_id) {
          return reject(new Error('Cloudinary returned no result for ' + safeName));
        }
        // Use exact URL from Cloudinary — never modify it or the file won't be found
        const fileUrl = result.secure_url || '';
        console.log('Uploaded:', safeName, '->', fileUrl);
        resolve({
          originalName:  safeName,
          publicId:      result.public_id,
          url:           fileUrl,
          resourceType:  result.resource_type || resourceType,
          format:        ext.replace('.', ''),
          size:          result.bytes         || buffer.length,
        });
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

function deleteFromCloudinary(publicId, resourceType) {
  if (!publicId) return Promise.resolve();
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType || 'image' })
    .catch(err => console.warn('Cloudinary delete warning:', err.message));
}

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API ROUTES ────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, dbFile: DB_FILE, dataDir: DATA_DIR, exists: fs.existsSync(DB_FILE) });
});

// GET all products
app.get('/api/products', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    const db = readDB();
    console.log('GET /api/products — returning', (db.products || []).length, 'products from', DB_FILE);
    res.json(db.products || []);
  } catch(e) {
    console.error('GET /api/products error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST create product
app.post('/api/products', upload.array('files'), async (req, res) => {
  try {
    const files = (await Promise.allSettled(
      (req.files || []).map(f => uploadToCloudinary(f.buffer, f.originalname, 'artwork_manager/artwork'))
    )).filter(r => {
      if (r.status === 'rejected') console.error('File upload skipped:', r.reason?.message);
      return r.status === 'fulfilled';
    }).map(r => r.value);
    const db      = readDB();
    const product = {
      id:          Date.now(),
      name:        req.body.name        || '',
      brand:       req.body.brand       || '',
      sourced:     req.body.sourced     || '',
      description: req.body.description || '',
      files,
      refFiles: [],
    };
    db.products.push(product);
    writeDB(db);
    res.json(product);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT update product
app.put('/api/products/:id', upload.array('newFiles'), async (req, res) => {
  try {
    const db  = readDB();
    const id  = parseInt(req.params.id, 10);
    const idx = db.products.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const p = db.products[idx];

    let keepIds = [];
    try { keepIds = JSON.parse(req.body.keepFiles || '[]'); } catch {}

    // Delete removed artwork files from Cloudinary
    const toDelete = p.files.filter(f => !keepIds.includes(f.publicId));
    await Promise.all(toDelete.map(f => deleteFromCloudinary(f.publicId, f.resourceType)));

    const keptFiles = p.files.filter(f => keepIds.includes(f.publicId));
    const newFiles  = (await Promise.allSettled(
      (req.files || []).map(f => uploadToCloudinary(f.buffer, f.originalname, 'artwork_manager/artwork'))
    )).filter(r => {
      if (r.status === 'rejected') console.error('File upload skipped:', r.reason?.message);
      return r.status === 'fulfilled';
    }).map(r => r.value);

    p.name        = req.body.name        || p.name;
    p.brand       = req.body.brand       || '';
    p.sourced     = req.body.sourced     !== undefined ? req.body.sourced : (p.sourced || '');
    p.description = req.body.description !== undefined ? req.body.description : (p.description || '');
    p.files   = [...keptFiles, ...newFiles];
    if (!p.refFiles) p.refFiles = [];

    db.products[idx] = p;
    writeDB(db);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE product
app.delete('/api/products/:id', async (req, res) => {
  try {
    const db  = readDB();
    const id  = parseInt(req.params.id, 10);
    const idx = db.products.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const p = db.products[idx];
    await Promise.all([
      ...(p.files    || []).map(f => deleteFromCloudinary(f.publicId, f.resourceType)),
      ...(p.refFiles || []).map(f => deleteFromCloudinary(f.publicId, f.resourceType)),
    ]);

    db.products.splice(idx, 1);
    writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE single artwork file
app.delete('/api/products/:id/files/:publicId(*)', async (req, res) => {
  try {
    const db  = readDB();
    const id  = parseInt(req.params.id, 10);
    const idx = db.products.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const p    = db.products[idx];
    const file = p.files.find(f => f.publicId === req.params.publicId);
    if (file) await deleteFromCloudinary(file.publicId, file.resourceType);
    p.files = p.files.filter(f => f.publicId !== req.params.publicId);

    db.products[idx] = p;
    writeDB(db);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST add reference files
app.post('/api/products/:id/refs', upload.array('refFiles'), async (req, res) => {
  try {
    const db  = readDB();
    const id  = parseInt(req.params.id, 10);
    const idx = db.products.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const newRefs = await Promise.all(
      (req.files || []).map(f => uploadToCloudinary(f.buffer, f.originalname, 'artwork_manager/refs'))
    );

    const p = db.products[idx];
    if (!p.refFiles) p.refFiles = [];
    p.refFiles = [...p.refFiles, ...newRefs];

    db.products[idx] = p;
    writeDB(db);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE single reference file
app.delete('/api/products/:id/refs/:publicId(*)', async (req, res) => {
  try {
    const db  = readDB();
    const id  = parseInt(req.params.id, 10);
    const idx = db.products.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const p    = db.products[idx];
    if (!p.refFiles) p.refFiles = [];
    const file = p.refFiles.find(f => f.publicId === req.params.publicId);
    if (file) await deleteFromCloudinary(file.publicId, file.resourceType);
    p.refFiles = p.refFiles.filter(f => f.publicId !== req.params.publicId);

    db.products[idx] = p;
    writeDB(db);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EXPORT ────────────────────────────────────────────────────────
app.get('/api/export', (req, res) => {
  try {
    const db  = readDB();
    const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="artwork-manager-backup-' + ts + '.zip"');
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => console.error('Export error:', err));
    archive.pipe(res);
    archive.append(JSON.stringify(db, null, 2), { name: 'products.json' });
    archive.finalize();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── IMPORT ────────────────────────────────────────────────────────
app.post('/api/import', importUpload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const zip = await unzipper.Open.buffer(req.file.buffer);

    let importedData = null;
    // Map of original storedName → buffer (for old-style local backups with actual files)
    const fileBuffers = {};

    // First pass — collect everything from zip
    for (const entry of zip.files) {
      if (entry.path === 'products.json') {
        importedData = JSON.parse((await entry.buffer()).toString('utf8'));
      } else if (entry.path.startsWith('uploads/') || entry.path.startsWith('ref-uploads/')) {
        // Old local backup format — has actual image files inside
        const buf = await entry.buffer();
        const basename = entry.path.split('/').pop();
        fileBuffers[basename] = { buffer: buf, path: entry.path };
      }
    }

    if (!importedData || !Array.isArray(importedData.products)) {
      return res.status(400).json({ error: 'Invalid backup: missing products.json' });
    }

    // If zip contains actual image files, upload them to Cloudinary
    // and build a map of storedName → new Cloudinary file object
    const cloudinaryMap = {};
    const uploadJobs = Object.entries(fileBuffers).map(async ([basename, { buffer, path: zipPath }]) => {
      try {
        const folder = zipPath.startsWith('ref-uploads/') ? 'artwork_manager/refs' : 'artwork_manager/artwork';
        const result = await uploadToCloudinary(buffer, basename, folder);
        cloudinaryMap[basename] = result;
        console.log('  ☁️  Uploaded to Cloudinary:', basename);
      } catch (e) {
        console.warn('  ⚠️  Failed to upload', basename, e.message);
      }
    });
    await Promise.all(uploadJobs);

    // Replace storedName-based file refs with Cloudinary URLs if we uploaded files
    if (Object.keys(cloudinaryMap).length > 0) {
      importedData.products = importedData.products.map(p => {
        p.files = (p.files || []).map(f => {
          const key = f.storedName || f.publicId;
          const basename = key ? key.split('/').pop() : null;
          if (basename && cloudinaryMap[basename]) return cloudinaryMap[basename];
          // Already has a Cloudinary url — keep as is
          if (f.url) return f;
          return f;
        });
        p.refFiles = (p.refFiles || []).map(f => {
          const key = f.storedName || f.publicId;
          const basename = key ? key.split('/').pop() : null;
          if (basename && cloudinaryMap[basename]) return cloudinaryMap[basename];
          if (f.url) return f;
          return f;
        });
        return p;
      });
    }

    const mode = req.query.mode || 'replace';
    const db   = readDB();

    if (mode === 'replace') {
      db.products = importedData.products;
    } else {
      const existingIds = new Set(db.products.map(p => p.id));
      importedData.products.forEach(p => {
        if (existingIds.has(p.id)) p.id = Date.now() + Math.round(Math.random() * 1e5);
        db.products.push(p);
      });
    }

    writeDB(db);
    res.json({
      ok: true,
      productCount:   db.products.length,
      filesUploaded:  Object.keys(cloudinaryMap).length,
    });
  } catch (e) { res.status(500).json({ error: 'Import failed: ' + e.message }); }
});

// ── PROXY DOWNLOAD — routes file download through server to avoid CORS ──
app.get('/api/download', async (req, res) => {
  const url      = req.query.url;
  const filename = req.query.filename || 'file';
  if (!url) return res.status(400).send('Missing url');

  try {
    // Try the URL as-is first, then fallback between raw/image if 404
    async function tryFetch(targetUrl) {
      // Build list of URLs to try in order
      const urls = [targetUrl];

      // 1. Try switching raw/image upload type
      if (targetUrl.includes('/raw/upload/'))
        urls.push(targetUrl.replace('/raw/upload/', '/image/upload/'));
      else if (targetUrl.includes('/image/upload/'))
        urls.push(targetUrl.replace('/image/upload/', '/raw/upload/'));

      // 2. Fix "_pdf.pdf" / "_cdr.cdr" double-extension bug from old upload code
      // e.g. "file_1234_pdf.pdf" → "file_1234_pdf" (Cloudinary stores without final ext for raw)
      const doubleExtMatch = targetUrl.match(/(_[a-z0-9]+)\.([a-z0-9]+)$/i);
      if (doubleExtMatch && doubleExtMatch[1] === '_' + doubleExtMatch[2]) {
        // strip the final .ext — e.g. "_pdf.pdf" → "_pdf"
        const stripped = targetUrl.replace(/\.[a-z0-9]+$/i, '');
        urls.push(stripped);
        if (stripped.includes('/raw/upload/'))
          urls.push(stripped.replace('/raw/upload/', '/image/upload/'));
        else if (stripped.includes('/image/upload/'))
          urls.push(stripped.replace('/image/upload/', '/raw/upload/'));
      }

      for (const u of urls) {
        console.log('Proxy: trying', u);
        const r = await fetch(u);
        if (r.ok) return r;
        console.log('Proxy: got', r.status, 'for', u);
      }
      return await fetch(targetUrl); // return last attempt
    }

    const response = await tryFetch(url);
    if (!response.ok) {
      console.error('Proxy upstream error:', response.status, url);
      return res.status(response.status).send('Upstream error: ' + response.status);
    }

    const safeFilename = filename.replace(/"/g, '_');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeFilename + '"');
    res.setHeader('Content-Type', 'application/octet-stream');

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log('Proxy download OK:', safeFilename, buffer.length, 'bytes');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch(e) {
    console.error('Proxy download error:', e.message, 'url:', url);
    if (!res.headersSent) res.status(500).send('Download failed: ' + e.message);
  }
});

// ── CATCH ALL — serve index.html for any non-API route ───────────
app.get('*', (req, res) => {
  const indexFile = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexFile)) {
    res.sendFile(indexFile);
  } else {
    res.status(404).send('index.html not found at ' + indexFile);
  }
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅  Product Manager running at http://localhost:' + PORT);
  console.log('  📁  Data stored in: ' + DATA_DIR);
  console.log('  📄  index.html at: ' + path.join(__dirname, 'public', 'index.html'));
  console.log('  ☁️   Files stored on: Cloudinary');
  console.log('');
});