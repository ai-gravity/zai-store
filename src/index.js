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
    if (!data) return { products: [], purchases: [], config: {} }
    const db = JSON.parse(data)
    recalculateStock(db)
    return db
  } catch (err) {
    console.error('Error reading DB, resetting database', err)
    return { products: [], purchases: [], config: {} }
  }
}

// Save Database Helper
async function writeDB(c, db) {
  recalculateStock(db)
  await c.env.ZAI_STORE_DB.put('db', JSON.stringify(db))
}

// Recalculate Stock Counts
function recalculateStock(db) {
  if (!db.purchases) db.purchases = []
  db.products.forEach(prod => {
    const totalPurchases = db.purchases.filter(p => p.product_id === prod.id).length
    prod.sales_count = totalPurchases
    // Default limit is Infinity if not set, or parse it
    const limit = prod.stock_limit > 0 ? prod.stock_limit : 999999
    prod.stock_remaining = Math.max(0, limit - totalPurchases)
    prod.stock_sold_out = prod.stock_remaining <= 0 || prod.is_active === false
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
  if (!client_id || token.startsWith('mock')) {
    try {
      // Decode mock token payload
      const base64Url = token.split('.')[1] || token
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
      const payload = JSON.parse(Buffer.from(base64, 'base64').toString())
      c.set('user', payload)
      return next()
    } catch (e) {
      c.set('user', { email: 'aitestgravity@gmail.com', picture: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&auto=format&fit=crop&q=60' })
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
  const adminEmail = 'aitestgravity@gmail.com'
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
  if (product.stock_sold_out) {
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

  // Record purchase history
  db.purchases.push({
    id: 'pur_' + Math.random().toString(36).substr(2, 9),
    product_id: product.id,
    email: email.toLowerCase(),
    amount: product.price_satang,
    date: new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })
  })

  await writeDB(c, db)
  console.log(`[Payment Fulfilled] Sold ${product.title} to ${email}`)

  // Redirect back to store page with success flash
  return c.redirect('/?checkout_success=true')
})

// 5. Get User Purchases
app.get('/api/me/purchases', authenticate, async (c) => {
  const user = c.get('user')
  const db = await readDB(c)
  
  const myPurchases = (db.purchases || []).filter(p => p.email === user.email.toLowerCase())
  
  const list = myPurchases.map(pur => {
    const product = db.products.find(p => p.id === pur.product_id)
    return {
      product_id: product ? product.id : '',
      title: product ? product.title : 'สินค้า',
      file_name: 'product_file.md',
      raw_key: product ? product.delivery_content : 'ไม่มีข้อมูลไฟล์',
      file_size: '0.01 MB',
      access_type: 'lifetime',
      purchase_date: pur.date
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
    image_url: body.image_url || '',
    stock_limit: parseInt(body.stock_limit) || 0,
    is_active: body.is_active !== false,
    delivery_content: body.delivery_content || '',
    sales_count: 0,
    stock_remaining: 0,
    stock_sold_out: false
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

// 5. Get full inventory overview
app.get('/api/admin/inventory', authenticate, requireAdmin, async (c) => {
  const db = await readDB(c)
  return c.json({
    purchases: db.purchases,
    products: db.products
  })
})



// 6. Edit Product
app.put('/api/admin/products/:id', authenticate, requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const db = await readDB(c)
  
  const product = db.products.find(p => p.id === id)
  if (!product) return c.json({ success: false, error: 'Not found' }, 404)
  
  if (body.title !== undefined) product.title = body.title
  if (body.description !== undefined) product.description = body.description
  if (body.image_url !== undefined) product.image_url = body.image_url
  if (body.price_satang !== undefined) product.price_satang = parseInt(body.price_satang)
  if (body.stock_limit !== undefined) product.stock_limit = parseInt(body.stock_limit)
  if (body.is_active !== undefined) product.is_active = body.is_active
  if (body.delivery_content !== undefined) product.delivery_content = body.delivery_content
  if (body.expiry_date !== undefined) product.expiry_date = body.expiry_date

  await writeDB(c, db)
  return c.json({ success: true, product })
})

// GLM Monitor API Mocks / Real Integration
app.get('/glm/api/usage', async (c) => {
  const db = await readDB(c);
  const globalKey = db.config?.globalApiKey;
  
  if (!globalKey) {
    return c.json({
      success: true,
      data: {
        level: 'ยังไม่ได้ตั้งค่า Global Key',
        limits: []
      }
    });
  }

  try {
    // Call Zhipu AI (GLM) usage endpoint
    const res = await fetch('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
      headers: { 'Authorization': 'Bearer ' + globalKey }
    });
    
    if (!res.ok) {
      return c.json({
        success: false,
        error: 'Failed to fetch usage: ' + res.status
      });
    }

    const json = await res.json();
    
    // Attempt to parse limit from JSON structure
    // Zhipu AI usually returns data.total, data.used, etc.
    const used = json.data?.used || 0;
    const total = json.data?.total || 0;
    
    return c.json({
      success: true,
      data: {
        level: 'Premium (Z.ai API)',
        limits: [
          { type: 'TOKENS_LIMIT', usage: used, limit: total, resetInSec: 86400 }
        ],
        raw_response: json
      }
    });
    
  } catch (err) {
    return c.json({ success: false, error: err.message });
  }
});

app.get('/glm/api/model-usage', (c) => {
  return c.json({
    success: true,
    data: {
      totalUsage: { totalTokensUsage: 0 },
      daily: []
    }
  });
});

app.get('/glm/api/system-status', (c) => {
  return c.json({ success: true, data: { speed: 1.0 } });
});

// Fallback to Pages static assets
app.get('*', async (c) => {
  return await c.env.ASSETS.fetch(c.req.raw)
})

export default app
