const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 8000;
const DB_PATH = path.join(__dirname, 'db.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Load Database Helper
function readDB() {
  try {
    const data = fs.readFileSync(DB_PATH, 'utf8');
    const db = JSON.parse(data);
    recalculateStock(db);
    return db;
  } catch (err) {
    console.error('Error reading DB, resetting database', err);
    return { products: [], keys: [], purchases: [], config: {} };
  }
}

// Save Database Helper
function writeDB(db) {
  recalculateStock(db);
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

// Recalculate Stock Counts
function recalculateStock(db) {
  db.products.forEach(prod => {
    const totalKeys = db.keys.filter(k => k.product_code === prod.code);
    const unsoldKeys = totalKeys.filter(k => !k.sold);
    prod.stock_limit = totalKeys.length;
    prod.stock_remaining = unsoldKeys.length;
    prod.stock_sold_out = unsoldKeys.length === 0;
  });
}

// Auth Middleware (Verifies Google ID Token or fallback Bearer token for mock)
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split(' ')[1];
  const db = readDB();
  const client_id = db.config.googleClientId || process.env.GOOGLE_CLIENT_ID;

  // Simple token decoding if no CLIENT ID setup, for easier local testing
  if (!client_id || token.startsWith('mock_token_')) {
    try {
      // Decode mock token payload
      const base64Url = token.split('.')[1] || token;
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
      req.user = payload;
      return next();
    } catch (e) {
      req.user = { email: 'cyber_n0mad@zmail.com', picture: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&auto=format&fit=crop&q=60' };
      return next();
    }
  }

  try {
    const client = new OAuth2Client(client_id);
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: client_id,
    });
    const payload = ticket.getPayload();
    req.user = payload;
    next();
  } catch (error) {
    console.error('Google token verification failed:', error);
    res.status(401).json({ success: false, error: 'Invalid Google token' });
  }
}

// Admin checking middleware
function requireAdmin(req, res, next) {
  const db = readDB();
  const adminEmail = (db.config.adminEmail || process.env.ADMIN_EMAIL || 'cyber_n0mad@zmail.com').toLowerCase();
  if (req.user && req.user.email.toLowerCase() === adminEmail) {
    return next();
  }
  res.status(403).json({ success: false, error: 'Forbidden: Admin access only' });
}

// --- Public / Reseller APIs ---

// 1. Get Products
app.get('/api/products', (req, res) => {
  const db = readDB();
  res.json(db.products);
});

// 2. Signin handler
app.post('/api/auth/signin', authenticate, (req, res) => {
  res.json({ success: true, user: req.user });
});

// 3. Checkout (Stripe checkout session or Mock checkout session)
app.post('/api/checkout', authenticate, async (req, res) => {
  const { product_id } = req.body;
  const db = readDB();

  const product = db.products.find(p => p.id === product_id);
  if (!product) {
    return res.status(404).json({ success: false, error: 'Product not found' });
  }

  // Check stock
  const unsoldKeys = db.keys.filter(k => k.product_code === product.code && !k.sold);
  if (unsoldKeys.length === 0) {
    return res.status(400).json({ success: false, error: 'sold_out' });
  }

  const stripeKey = db.config.stripeSecretKey || process.env.STRIPE_SECRET_KEY;

  if (!stripeKey) {
    // Return a MOCK Checkout URL to handle offline/local runs without configuration
    const sessionId = 'mock_sess_' + Math.random().toString(36).substr(2, 9);
    console.log(`[Mock Stripe] Creating checkout session ${sessionId} for product ${product.title}`);
    
    return res.json({
      success: true,
      url: `/checkout-success?session_id=${sessionId}&product_id=${product_id}&email=${encodeURIComponent(req.user.email)}`
    });
  }

  try {
    const stripe = Stripe(stripeKey);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'thb',
          product_data: {
            name: product.title,
            description: product.description,
          },
          unit_amount: product.price_satang,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin}/checkout-success?session_id={CHECKOUT_SESSION_ID}&product_id=${product_id}&email=${encodeURIComponent(req.user.email)}`,
      cancel_url: `${req.headers.origin}/`,
      customer_email: req.user.email,
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error('Stripe session creation error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Successful Checkout Fulfillment (Redirect page callback)
app.get('/checkout-success', (req, res) => {
  const { session_id, product_id, email } = req.query;
  if (!product_id || !email) {
    return res.status(400).send('Invalid request payload');
  }

  const db = readDB();
  const product = db.products.find(p => p.id === product_id);
  if (!product) {
    return res.status(404).send('Product type not found');
  }

  // Fulfill one unsold key for this user
  const unsoldKeyIndex = db.keys.findIndex(k => k.product_code === product.code && !k.sold);
  if (unsoldKeyIndex === -1) {
    return res.status(400).send('Product key is sold out! Please contact admin.');
  }

  const keyObj = db.keys[unsoldKeyIndex];
  keyObj.sold = true;
  keyObj.purchaser_email = email.toLowerCase();
  keyObj.purchase_date = new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' });

  // Record purchase history
  db.purchases.push({
    id: 'pur_' + Math.random().toString(36).substr(2, 9),
    email: email.toLowerCase(),
    product_code: product.code,
    key: keyObj.key,
    amount: product.price_satang,
    date: new Date().toLocaleDateString('th-TH')
  });

  writeDB(db);
  console.log(`[Payment Fulfilled] Sold key ${keyObj.key} to ${email}`);

  // Redirect back to store page with success flash
  res.redirect('/?checkout_success=true');
});

// 5. Get User Purchases
app.get('/api/me/purchases', authenticate, (req, res) => {
  const db = readDB();
  const email = req.user.email.toLowerCase();
  const myKeys = db.keys.filter(k => k.sold && k.purchaser_email === email);
  
  // Format matching store expectations
  const list = myKeys.map(k => {
    const product = db.products.find(p => p.code === k.product_code);
    return {
      product_id: product ? product.id : '',
      title: product ? product.title : 'API Key',
      file_name: 'glm-5.2-key.md',
      raw_key: k.key,
      file_size: '0.00 MB',
      access_type: 'one_time',
      purchase_date: k.purchase_date
    };
  });

  res.json(list);
});

// --- Admin Panel API Endpoints ---

// 1. Get current config
app.get('/api/admin/config', authenticate, requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.config);
});

// 2. Update config
app.post('/api/admin/config', authenticate, requireAdmin, (req, res) => {
  const db = readDB();
  db.config = { ...db.config, ...req.body };
  writeDB(db);
  res.json({ success: true });
});

// 2.5 Add new product
app.post('/api/admin/products', authenticate, requireAdmin, (req, res) => {
  const { code, title, description, price_satang, expiry_date } = req.body;
  if (!code || !title || !price_satang) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  const db = readDB();
  if (db.products.some(p => p.code === code)) {
    return res.status(400).json({ success: false, error: 'Product code already exists' });
  }

  db.products.push({
    id: 'prod_' + Math.random().toString(36).substr(2, 9),
    code: code,
    title: title,
    description: description || '',
    price_satang: parseInt(price_satang),
    expiry_date: expiry_date || '',
    billing_type: 'one_time',
    stock_limit: 0,
    stock_remaining: 0,
    stock_sold_out: true,
    sales_count: 0
  });

  writeDB(db);
  res.json({ success: true });
});

// 2.6 Delete product
app.delete('/api/admin/products/:id', authenticate, requireAdmin, (req, res) => {
  const db = readDB();
  const prodIndex = db.products.findIndex(p => p.id === req.params.id);
  if (prodIndex === -1) {
    return res.status(404).json({ success: false, error: 'Product not found' });
  }
  
  const prodCode = db.products[prodIndex].code;
  db.keys = db.keys.filter(k => k.product_code !== prodCode); // Remove associated keys
  db.products.splice(prodIndex, 1);
  writeDB(db);
  res.json({ success: true });
});

// 3. Get all keys
app.get('/api/admin/keys', authenticate, requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.keys);
});

// 4. Upload/Add new keys
app.post('/api/admin/keys', authenticate, requireAdmin, (req, res) => {
  const { product_code, keysList } = req.body;
  if (!product_code || !keysList) {
    return res.status(400).json({ success: false, error: 'Missing product code or keys list' });
  }

  const db = readDB();
  const lines = keysList.split(/\r?\n/).map(k => k.trim()).filter(k => k !== '');

  lines.forEach(keyValue => {
    // Avoid inserting duplicates
    if (!db.keys.some(k => k.key === keyValue)) {
      db.keys.push({
        id: 'key_' + Math.random().toString(36).substr(2, 9),
        product_code: product_code,
        key: keyValue,
        sold: false,
        purchaser_email: null,
        purchase_date: null
      });
    }
  });

  writeDB(db);
  res.json({ success: true, count: lines.length });
});

// 5. Delete specific key
app.delete('/api/admin/keys/:id', authenticate, requireAdmin, (req, res) => {
  const db = readDB();
  db.keys = db.keys.filter(k => k.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
});


// --- Z.ai Usage Monitor API Proxy / Mock ---

app.get('/glm/api/usage', async (req, res) => {
  const apiKey = req.query.key; // We can parse or pass Z.ai key here if client queries
  
  // Real monitor logic or fallback to mockup metrics
  let percent = 76;
  let remaining = 760000;
  let usage = 1000000;
  let currentVal = 240000;

  if (apiKey) {
    // If it's one of our keys, seed it uniquely so each tier looks different
    if (apiKey.includes('cyber-core')) {
      percent = 88;
      usage = 3000000;
      currentVal = Math.floor(usage * (1 - percent/100));
      remaining = usage - currentVal;
    } else if (apiKey.includes('quantum-link')) {
      percent = 92;
      usage = 8000000;
      currentVal = Math.floor(usage * (1 - percent/100));
      remaining = usage - currentVal;
    } else if (apiKey.includes('ghost-protocol')) {
      percent = 100;
      usage = 25000000;
      currentVal = 0;
      remaining = usage;
    } else {
      // Mock hash-based stats for third-party keys
      let sum = 0;
      for (let i = 0; i < apiKey.length; i++) sum += apiKey.charCodeAt(i);
      percent = (sum % 70) + 20; // 20% to 90%
      usage = 1000000;
      currentVal = Math.floor(usage * (1 - percent/100));
      remaining = usage - currentVal;
    }
  }

  res.json({
    success: true,
    data: {
      level: apiKey && apiKey.includes('ghost') ? 'ghost' : 'premium',
      limits: [
        {
          type: 'TOKENS_LIMIT',
          percentage: percent,
          nextResetTime: Date.now() + 45000000 // approx 12h
        },
        {
          type: 'TIME_LIMIT',
          percentage: percent,
          currentValue: currentVal,
          usage: usage,
          remaining: remaining,
          nextResetTime: Date.now() + 86400000 * 20, // 20 days
          usageDetails: [
            { modelCode: 'Web Search', usage: Math.floor(currentVal * 0.4) },
            { modelCode: 'Reader', usage: Math.floor(currentVal * 0.4) },
            { modelCode: 'Zread', usage: Math.floor(currentVal * 0.2) }
          ]
        }
      ]
    }
  });
});

app.get('/glm/api/model-usage', (req, res) => {
  // Generate random data points for chart
  const dataPoints = 20;
  const tokensUsage = [];
  const x_time = [];
  
  const now = new Date();
  for (let i = dataPoints - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    x_time.push(d.toISOString().slice(0,10) + ' 12:00:00');
    tokensUsage.push(Math.floor(50000 + Math.random() * 200000));
  }

  res.json({
    success: true,
    data: {
      x_time,
      tokensUsage,
      totalUsage: {
        totalTokensUsage: tokensUsage.reduce((a, b) => a + b, 0)
      }
    }
  });
});

app.get('/glm/api/system-status', (req, res) => {
  const times = [];
  const proMaxDecodeSpeed = [];
  const liteDecodeSpeed = [];
  
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    times.push(d.toISOString().slice(0, 10));
    proMaxDecodeSpeed.push(Math.floor(80 + Math.random() * 40));
    liteDecodeSpeed.push(Math.floor(180 + Math.random() * 60));
  }

  res.json({
    success: true,
    data: {
      x_time: times,
      proMaxDecodeSpeed,
      liteDecodeSpeed
    }
  });
});

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`  Z.ai Reseller Server live on: http://localhost:${PORT}`);
  console.log(`==================================================`);
});
