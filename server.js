const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3700;

const API_KEY = process.env.NVIDIA_API_KEY;
const IMG_DIR = path.join(__dirname, 'public', 'images');
const META_FILE = path.join(__dirname, 'images-meta.json');

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, '[]');

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Generate image
app.post('/api/generate', async (req, res) => {
  const { endpoint, body } = req.body;
  console.log('[Generate]', endpoint, JSON.stringify(body));
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    console.log('[Response]', response.status);

    const text = await response.text();

    if (!response.ok) {
      console.log('[Error Response]', text.slice(0, 200));
      try { return res.status(response.status).json(JSON.parse(text)); }
      catch { return res.status(response.status).json({ error: text.slice(0, 300) || 'NVIDIA API error ' + response.status }); }
    }

    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(500).json({ error: 'Invalid response from NVIDIA API' }); }

    // Extract base64 image
    let b64 = '';
    if (data.artifacts && data.artifacts[0]) {
      if (data.artifacts[0].finishReason === 'CONTENT_FILTERED') {
        console.log('[Filtered] NVIDIA content filter triggered');
        return res.status(422).json({ error: 'Image was blocked by NVIDIA safety filter. Try rephrasing your prompt.' });
      }
      b64 = data.artifacts[0].base64;
    }
    else if (data.image) b64 = data.image;
    else if (data.b64_json) b64 = data.b64_json;

    if (!b64) {
      console.log('[Debug] Response keys:', Object.keys(data));
      return res.status(500).json({ error: 'No image in response' });
    }

    // Check for black/blank image (safety filter) - filtered images are tiny
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 15000) {
      console.log('[Filtered] Image too small (' + buf.length + ' bytes) - likely safety filtered');
      return res.status(422).json({ error: 'Image was blocked by safety filter. Try a different prompt.' });
    }

    // Save to disk
    const filename = 'kayou-' + Date.now() + '.jpg';
    fs.writeFileSync(path.join(IMG_DIR, filename), buf);
    console.log('[Saved]', filename, buf.length + ' bytes');

    res.json({ filename: '/images/' + filename });
  } catch (e) {
    console.error('[Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Save metadata
app.post('/api/meta', (req, res) => {
  fs.writeFileSync(META_FILE, JSON.stringify(req.body));
  res.json({ ok: true });
});

// Get metadata
app.get('/api/meta', (req, res) => {
  const data = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  res.json(data);
});

// Delete image
app.delete('/api/image/:filename', (req, res) => {
  const filepath = path.join(IMG_DIR, req.params.filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  res.json({ ok: true });
});

// Health check endpoint — sends a tiny test prompt to see if model responds
app.post('/api/health', async (req, res) => {
  const { endpoint, fmt } = req.body;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let body;
    if (fmt === 'sd3') {
      body = { prompt: 'test', cfg_scale: 5, steps: 10, aspect_ratio: '1:1', seed: 1 };
    } else {
      body = { prompt: 'test', width: 768, height: 768 };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const ok = response.ok;
    console.log('[Health]', endpoint.split('/').pop(), ok ? 'UP' : 'DOWN (' + response.status + ')');
    res.json({ ok });
  } catch (e) {
    console.log('[Health]', endpoint.split('/').pop(), 'DOWN (' + e.message + ')');
    res.json({ ok: false });
  }
});

app.listen(PORT, () => console.log(`Kayou Image Generative running at http://localhost:${PORT}`));
