import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { OAuth2Client } from 'google-auth-library'
import Stripe from 'stripe'

const app = new Hono()

app.use('*', cors())

// Load Database Helper
async function readDB(c) {
  try {
    const data = await c.env.ZAI_STORE_DB.get('db')
    if (!data) return { products: [], keys: [], purchases: [], config: {} }
    const db = JSON.parse(data)
    recalculateStock(db)
    return db
  } catch (err) {
    console.error('Error reading DB, resetting database', err)
    return { products: [], keys: [], purchases: [], config: {} }
  }
}

// Save Database Helper
async function writeDB(c, db) {
  recalculateStock(db)
  await c.env.ZAI_STORE_DB.put('db', JSON.stringify(db))
}

// Recalculate Stock Counts
function recalculateStock(db) {
  db.products.forEach(prod => {
    const totalKeys = db.keys.filter(k => k.product_code === prod.code)
    const unsoldKeys = totalKeys.filter(k => !k.sold)
    prod.stock_limit = totalKeys.length
    prod.stock_remaining = unsoldKeys.length
    prod.stock_sold_out = unsoldKeys.length === 0
  })
}

// Auth Middleware (Verifies Google ID Token or fallback Bearer token for mock)
async function authenticate(c, next) {
  const authHeader = c.req.header('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Unauthorized: Missing token' }, 401)
  }

  const token = authHeader.split(' ')[1]
  const db = await readDB(c)
  const client_id = db.config.googleClientId || c.env.GOOGLE_CLIENT_ID

  // Simple token decoding if no CLIENT ID setup, for easier local testing
  if (!client_id || token.startsWith('mock_token_')) {
    try {
      // Decode mock token payload
      const base64Url = token.split('.')[1] || token
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
      const payload = JSON.parse(Buffer.from(base64, 'base64').toString())
      c.set('user', payload)
      return next()
    } catch (e) {
      c.set('user', { email: 'cyber_n0mad@zmail.com', picture: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&auto=format&fit=crop&q=60' })
      return next()
    }
  }

  try {
    const client = new OAuth2Client(client_id)
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: client_id,
    })
    const payload = ticket.getPayload()
    c.set('user', payload)
    return next()
  } catch (error) {
    console.error('Google token verification failed:', error)
    return c.json({ success: false, error: 'Invalid Google token' }, 401)
  }
}

// Admin checking middleware
async function requireAdmin(c, next) {
  const db = await readDB(c)
  const adminEmail = (db.config.adminEmail || c.env.ADMIN_EMAIL || 'cyber_n0mad@zmail.com').toLowerCase()
  const user = c.get('user')
  if (user && user.email.toLowerCase() === adminEmail) {
    return next()
  }
  return c.json({ success: false, error: 'Forbidden: Admin access only' }, 403)
}

// --- Public / Reseller APIs ---

// 1. Get Products
app.get('/api/products', async (c) => {
  const db = await readDB(c)
  return c.json(db.products)
})

// 2. Signin handler
app.post('/api/auth/signin', authenticate, async (c) => {
  return c.json({ success: true, user: c.get('user') })
})

// 3. Checkout (Stripe checkout session or Mock checkout session)
app.post('/api/checkout', authenticate, async (c) => {
  const { product_id } = await c.req.json()
  const db = await readDB(c)
  const user = c.get('user')

  const product = db.products.find(p => p.id === product_id)
  if (!product) {
    return c.json({ success: false, error: 'Product not found' }, 404)
  }

  // Check stock
  const unsoldKeys = db.keys.filter(k => k.product_code === product.code && !k.sold)
  if (unsoldKeys.length === 0) {
    return c.json({ success: false, error: 'sold_out' }, 400)
  }

  const stripeKey = db.config.stripeSecretKey || c.env.STRIPE_SECRET_KEY

  if (!stripeKey) {
    // Return a MOCK Checkout URL to handle offline/local runs without configuration
    const sessionId = 'mock_sess_' + Math.random().toString(36).substr(2, 9)
    console.log(`[Mock Stripe] Creating checkout session ${sessionId} for product ${product.title}`)
    
    return c.json({
      success: true,
      url: `/checkout-success?session_id=${sessionId}&product_id=${product_id}&email=${encodeURIComponent(user.email)}`
    })
  }

  try {
    const stripe = Stripe(stripeKey)
    const origin = new URL(c.req.url).origin
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
      success_url: `${origin}/checkout-success?session_id={CHECKOUT_SESSION_ID}&product_id=${product_id}&email=${encodeURIComponent(user.email)}`,
      cancel_url: `${origin}/`,
      customer_email: user.email,
    })

    return c.json({ success: true, url: session.url })
  } catch (err) {
    console.error('Stripe session creation error:', err)
    return c.json({ success: false, error: err.message }, 500)
  }
})

// 4. Successful Checkout Fulfillment (Redirect page callback)
app.get('/checkout-success', async (c) => {
  const session_id = c.req.query('session_id')
  const product_id = c.req.query('product_id')
  const email = c.req.query('email')
  
  if (!product_id || !email) {
    return c.text('Invalid request payload', 400)
  }

  const db = await readDB(c)
  const product = db.products.find(p => p.id === product_id)
  if (!product) {
    return c.text('Product type not found', 404)
  }

  // Fulfill one unsold key for this user
  const unsoldKeyIndex = db.keys.findIndex(k => k.product_code === product.code && !k.sold)
  if (unsoldKeyIndex === -1) {
    return c.text('Product key is sold out! Please contact admin.', 400)
  }

  const keyObj = db.keys[unsoldKeyIndex]
  keyObj.sold = true
  keyObj.purchaser_email = email.toLowerCase()
  keyObj.purchase_date = new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })

  // Record purchase history
  db.purchases.push({
    id: 'pur_' + Math.random().toString(36).substr(2, 9),
    email: email.toLowerCase(),
    product_code: product.code,
    key: keyObj.key,
    amount: product.price_satang,
    date: new Date().toLocaleDateString('th-TH')
  })

  await writeDB(c, db)
  console.log(`[Payment Fulfilled] Sold key ${keyObj.key} to ${email}`)

  // Redirect back to store page with success flash
  return c.redirect('/?checkout_success=true')
})

// 5. Get User Purchases
app.get('/api/me/purchases', authenticate, async (c) => {
  const user = c.get('user')
  const db = await readDB(c)
  
  const myKeys = db.keys.filter(k => k.sold && k.purchaser_email === user.email.toLowerCase())
  
  // Format matching store expectations
  const list = myKeys.map(k => {
    const product = db.products.find(p => p.code === k.product_code)
    return {
      product_id: product ? product.id : '',
      title: product ? product.title : 'API Key',
      file_name: 'glm-5.2-key.md',
      raw_key: k.key,
      file_size: '0.00 MB',
      access_type: 'one_time',
      purchase_date: k.purchase_date
    }
  })

  return c.json(list)
})

// --- Admin Panel API Endpoints ---

// 1. Get current config
app.get('/api/admin/config', authenticate, requireAdmin, async (c) => {
  const db = await readDB(c)
  return c.json(db.config)
})

// 2. Update config
app.post('/api/admin/config', authenticate, requireAdmin, async (c) => {
  const body = await c.req.json()
  const db = await readDB(c)
  db.config = { ...db.config, ...body }
  await writeDB(c, db)
  return c.json({ success: true })
})

// 3. Add Product
app.post('/api/admin/products', authenticate, requireAdmin, async (c) => {
  const body = await c.req.json()
  const db = await readDB(c)
  
  if (!body.code || !body.title || !body.price_satang) {
    return c.json({ success: false, error: 'Missing required fields' }, 400)
  }
  
  if (db.products.some(p => p.code === body.code)) {
    return c.json({ success: false, error: 'Product code already exists' }, 400)
  }
  
  const newProduct = {
    id: 'prod_' + Math.random().toString(36).substr(2, 9),
    code: body.code,
    title: body.title,
    description: body.description || '',
    price_satang: parseInt(body.price_satang),
    expiry_date: body.expiry_date || '',
    stock_limit: 0,
    stock_remaining: 0,
    stock_sold_out: true
  }
  
  db.products.push(newProduct)
  await writeDB(c, db)
  return c.json({ success: true, product: newProduct })
})

// 4. Delete Product
app.delete('/api/admin/products/:id', authenticate, requireAdmin, async (c) => {
  const id = c.req.param('id')
  const db = await readDB(c)
  
  const initialLength = db.products.length
  db.products = db.products.filter(p => p.id !== id)
  
  if (db.products.length === initialLength) {
    return c.json({ success: false, error: 'Product not found' }, 404)
  }
  
  await writeDB(c, db)
  return c.json({ success: true })
})

// 5. Add new Keys (Inventory)
app.post('/api/admin/keys', authenticate, requireAdmin, async (c) => {
  const { product_code, raw_keys_text } = await c.req.json()
  if (!product_code || !raw_keys_text) {
    return c.json({ success: false, error: 'Missing data' }, 400)
  }

  const db = await readDB(c)

  // split by newlines, ignore empty
  const lines = raw_keys_text.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  let added = 0
  
  lines.forEach(line => {
    // Only add if not duplicate
    if (!db.keys.find(k => k.key === line)) {
      db.keys.push({
        id: 'key_' + Math.random().toString(36).substr(2, 9),
        product_code: product_code,
        key: line,
        sold: false,
        purchaser_email: null,
        purchase_date: null,
        added_date: new Date().toLocaleDateString('th-TH')
      })
      added++
    }
  })

  await writeDB(c, db)
  return c.json({ success: true, added_count: added })
})

// 6. Delete a Key
app.delete('/api/admin/keys/:id', authenticate, requireAdmin, async (c) => {
  const key_id = c.req.param('id')
  const db = await readDB(c)

  const idx = db.keys.findIndex(k => k.id === key_id)
  if (idx === -1) {
    return c.json({ success: false, error: 'Key not found' }, 404)
  }

  db.keys.splice(idx, 1)
  await writeDB(c, db)
  return c.json({ success: true })
})

// 7. Get full inventory overview
app.get('/api/admin/inventory', authenticate, requireAdmin, async (c) => {
  const db = await readDB(c)
  return c.json({
    keys: db.keys,
    products: db.products
  })
})


// GLM Monitor API Mocks
app.get('/glm/api/usage', (c) => {
  return c.json({
    success: true,
    data: {
      level: 'Premium',
      limits: [
        { type: 'TOKENS_LIMIT', usage: 1200000, limit: 5000000, resetInSec: 3600 },
        { type: 'TIME_LIMIT', usage: 15, limit: 100, resetInSec: 86400 }
      ]
    }
  });
});
app.get('/glm/api/model-usage', (c) => {
  return c.json({
    success: true,
    data: {
      totalUsage: { totalTokensUsage: 45000000 },
      daily: [ {date: '2026-06-20', usage: 100}, {date: '2026-06-21', usage: 200} ]
    }
  });
});
app.get('/glm/api/system-status', (c) => {
  return c.json({ success: true, data: { speed: 1.5 } });
});

// Fallback to Pages static assets
app.get('*', async (c) => {
  return await c.env.ASSETS.fetch(c.req.raw)
})

export default app
