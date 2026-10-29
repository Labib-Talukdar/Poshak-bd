require('dotenv').config()

const crypto = require('node:crypto')
const express = require('express')
const fs = require('node:fs')
const path = require('node:path')
const multer = require('multer')
const { Pool } = require('pg')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const cookieParser = require('cookie-parser')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://poshak:poshak@localhost:5432/poshak',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false
})

fs.mkdirSync('public/uploads', { recursive: true })
const upload = multer({
  storage: multer.diskStorage({
    destination: 'public/uploads',
    filename(q, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext)
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(q, file, cb) {
    cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype))
  }
})

function slugify(value) {
  return String(value || 'uncategorized').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'uncategorized'
}

function parseSizes(value) {
  const sizes = [...new Set(String(value || '').split(',').map(v => v.trim()).filter(Boolean))]
  return sizes.length ? sizes : ['One Size']
}

function mapProduct(row) {
  return {
    id: Number(row.id),
    name: row.name,
    price: Number(row.price),
    category: row.category || '',
    sizes: row.sizes || '',
    image: row.image || '',
    stock: Number(row.stock || 0),
    active: row.active
  }
}

async function productFlatRows(client, where = '') {
  const params = []
  const result = await client.query(`
    SELECT p.id,p.name,p.base_price_bdt AS price,c.name AS category,
           p.image_url_or_key AS image,
           COALESCE((SELECT SUM(i.quantity_on_hand-i.reserved_quantity)
                     FROM product_variants pv
                     JOIN inventory i ON i.product_variant_id=pv.id
                     WHERE pv.product_id=p.id AND pv.is_active=TRUE),0)::int AS stock,
           COALESCE((SELECT string_agg(vav.value, ',' ORDER BY vav.value)
                     FROM product_variants pv
                     JOIN product_variant_attribute_values pvav ON pvav.product_variant_id=pv.id
                     JOIN variant_attribute_values vav ON vav.id=pvav.attribute_value_id
                     JOIN variant_attributes va ON va.id=vav.attribute_id AND va.code='size'
                     WHERE pv.product_id=p.id AND pv.is_active=TRUE), '') AS sizes,
           (p.status='active') AS active
    FROM products p
    LEFT JOIN categories c ON c.id=p.category_id
    ${where}
    ORDER BY p.id DESC`, params)
  return result.rows.map(mapProduct)
}

async function ensureVariantAttributes(client) {
  await client.query(`INSERT INTO variant_attributes(name,code,sort_order) VALUES('Size','size',10),('Color','color',20)
    ON CONFLICT(code) DO NOTHING`)
}

async function syncProductVariants(client, productId, sizes, stock) {
  await ensureVariantAttributes(client)
  await client.query('DELETE FROM product_variants WHERE product_id=$1', [productId])
  const allocations = parseSizes(sizes)
  const total = allocations.length
  const base = Math.floor(stock / total)
  const remainder = stock % total

  for (let index = 0; index < allocations.length; index++) {
    const size = allocations[index]
    const sku = `SKU-${productId}-${slugify(size)}-${index + 1}`.toUpperCase()
    const variant = await client.query(
      'INSERT INTO product_variants(product_id,sku,is_active) VALUES($1,$2,TRUE) RETURNING id',
      [productId, sku]
    )
    const variantId = variant.rows[0].id

    for (const [code, value] of [['size', size], ['color', 'Not specified']]) {
      const valueRow = await client.query(`
        INSERT INTO variant_attribute_values(attribute_id,value)
        SELECT id,$2 FROM variant_attributes WHERE code=$1
        ON CONFLICT(attribute_id,value) DO UPDATE SET value=EXCLUDED.value RETURNING id`, [code, value])
      await client.query(`INSERT INTO product_variant_attribute_values(product_variant_id,attribute_value_id)
        VALUES($1,$2) ON CONFLICT DO NOTHING`, [variantId, valueRow.rows[0].id])
    }

    await client.query(`INSERT INTO inventory(product_variant_id,quantity_on_hand,reserved_quantity)
      VALUES($1,$2,0)`, [variantId, base + (index < remainder ? 1 : 0)])
  }
}

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'development-only-secret-change-me')
if (process.env.NODE_ENV === 'production' && !JWT_SECRET) throw new Error('JWT_SECRET is required in production')
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false })
const admin = async (q, s, next) => {
  const token = q.cookies?.poshak_admin_token || String(q.headers.authorization || '').replace(/^Bearer\s+/i, '') || ''
  if (!token) return s.status(401).json({ error: 'Admin authentication required' })
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    if (payload.role !== 'admin') return s.status(403).json({ error: 'Admin access required' })
    q.adminUser = payload
    return next()
  } catch { return s.status(401).json({ error: 'Admin session expired or invalid' }) }
}
const app = express()
app.use(helmet({ contentSecurityPolicy: false }))
app.use(cookieParser())
app.use(express.json({ limit: '50kb' }))
app.use(express.static('client/dist'))
app.use(express.static('public'))

app.get('/api/health', async (q, s) => {
  try {
    await pool.query('SELECT 1')
    s.json({ ok: true, service: 'poshak' })
  } catch (error) {
    s.status(503).json({ ok: false, error: 'Database unavailable' })
  }
})

async function ensureGuestLookupSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS guest_phone_challenges (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    phone TEXT NOT NULL,
    otp_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_at TIMESTAMPTZ
  )`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_guest_phone_challenges_phone_created ON guest_phone_challenges(phone,created_at DESC)`)
  await pool.query(`CREATE TABLE IF NOT EXISTS guest_lookup_sessions (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    phone TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_guest_lookup_sessions_phone ON guest_lookup_sessions(phone)`)
}
ensureGuestLookupSchema().catch(error => console.error('Guest lookup schema setup failed:', error.message))

async function ensureAdminAccount() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()
  const password = String(process.env.ADMIN_PASSWORD || '')
  if (!email || !password || password === 'change-me') return
  const passwordHash = await bcrypt.hash(password, 12)
  await pool.query(`INSERT INTO users(email,password_hash,full_name,role,is_active)
    VALUES($1,$2,'Store Administrator','admin',TRUE)
    ON CONFLICT (email) DO UPDATE SET role='admin',is_active=TRUE,updated_at=CURRENT_TIMESTAMP`, [email,passwordHash])
}
ensureAdminAccount().catch(error => console.error('Admin account setup failed:', error.message))

function normalizePhone(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '')
  if (digits.startsWith('880')) return '0' + digits.slice(3)
  return digits
}

const otpChallengeRequests = new Map()
function checkOtpRequestLimit(phone, ip) {
  const key = `${phone}:${ip}`
  const now = Date.now()
  const entries = (otpChallengeRequests.get(key) || []).filter(timestamp => now - timestamp < 60 * 60 * 1000)
  if (entries.length >= 5) return false
  entries.push(now)
  otpChallengeRequests.set(key, entries)
  return true
}

app.post('/api/admin/auth/login', loginLimiter, async (q, s, next) => {
  const email = String(q.body?.email || '').trim().toLowerCase()
  const password = String(q.body?.password || '')
  if (!email || !password) return s.status(400).json({ error: 'Email and password are required' })
  try {
    const result = await pool.query(`SELECT id,email,password_hash,full_name,role,is_active FROM users WHERE email=$1`, [email])
    const user = result.rows[0]
    if (!user || !user.is_active || user.role !== 'admin' || !(await bcrypt.compare(password, user.password_hash))) {
      return s.status(401).json({ error: 'Invalid admin credentials' })
    }
    const token = jwt.sign({ sub:Number(user.id), email:user.email, role:user.role }, JWT_SECRET, { expiresIn:'8h' })
    s.cookie('poshak_admin_token', token, { httpOnly:true, secure:process.env.NODE_ENV === 'production', sameSite:'strict', maxAge:8*60*60*1000 })
    s.json({ ok:true, user:{ id:Number(user.id),email:user.email,name:user.full_name,role:user.role } })
  } catch (e) { next(e) }
})

app.post('/api/admin/auth/logout', (q,s) => {
  s.clearCookie('poshak_admin_token', { httpOnly:true, secure:process.env.NODE_ENV === 'production', sameSite:'strict' })
  s.json({ ok:true })
})

app.get('/api/admin/auth/me', admin, (q,s) => s.json({ user:{ id:q.adminUser.sub,email:q.adminUser.email,role:q.adminUser.role } }))

app.get('/api/products', async (q, s, next) => {
  try { s.json(await productFlatRows(pool, 'WHERE p.status=\'active\'')) } catch (e) { next(e) }
})

app.post('/api/orders/lookup/request', async (q, s, next) => {
  const phone = normalizePhone(q.body?.phone)
  if (!/^01[3-9]\d{8}$/.test(phone)) return s.status(400).json({ error: 'Enter a valid Bangladesh phone number' })
  if (!checkOtpRequestLimit(phone, q.ip)) return s.status(429).json({ error: 'Too many OTP requests. Try again later.' })

  const otp = String(crypto.randomInt(100000, 1000000))
  const otpHash = crypto.createHash('sha256').update(`${phone}:${otp}`).digest('hex')
  try {
    await pool.query(`UPDATE guest_phone_challenges SET expires_at=CURRENT_TIMESTAMP WHERE phone=$1 AND expires_at>CURRENT_TIMESTAMP AND verified_at IS NULL`, [phone])
    const challenge = await pool.query(`INSERT INTO guest_phone_challenges(phone,otp_hash,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP + INTERVAL '10 minutes') RETURNING id`, [phone, otpHash])
    const response = { challengeId: Number(challenge.rows[0].id), expiresInMinutes: 10, delivery: process.env.OTP_DELIVERY_MODE === 'provider' ? 'provider' : 'mock' }
    if (process.env.OTP_DELIVERY_MODE !== 'provider') response.devOtp = otp
    s.json(response)
  } catch (e) { next(e) }
})

app.post('/api/orders/lookup/verify', async (q, s, next) => {
  const phone = normalizePhone(q.body?.phone)
  const otp = String(q.body?.otp || '').trim()
  const challengeId = Number(q.body?.challengeId)
  if (!/^01[3-9]\d{8}$/.test(phone) || !/^\d{6}$/.test(otp) || !Number.isSafeInteger(challengeId)) {
    return s.status(400).json({ error: 'Phone number, challenge and 6-digit OTP are required' })
  }
  try {
    const result = await pool.query(`SELECT * FROM guest_phone_challenges WHERE id=$1 AND phone=$2 AND expires_at>CURRENT_TIMESTAMP AND verified_at IS NULL FOR UPDATE`, [challengeId, phone])
    if (!result.rows.length) return s.status(400).json({ error: 'OTP expired or challenge is invalid' })
    const challenge = result.rows[0]
    if (challenge.attempts >= 5) return s.status(429).json({ error: 'Too many incorrect attempts' })
    const providedHash = crypto.createHash('sha256').update(`${phone}:${otp}`).digest('hex')
    if (!crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(challenge.otp_hash))) {
      await pool.query('UPDATE guest_phone_challenges SET attempts=attempts+1 WHERE id=$1', [challengeId])
      return s.status(401).json({ error: 'Incorrect OTP' })
    }
    await pool.query('UPDATE guest_phone_challenges SET verified_at=CURRENT_TIMESTAMP WHERE id=$1', [challengeId])
    const lookupToken = crypto.randomBytes(32).toString('base64url')
    const lookupTokenHash = crypto.createHash('sha256').update(lookupToken).digest('hex')
    await pool.query(`INSERT INTO guest_lookup_sessions(phone,token_hash,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP + INTERVAL '24 hours')`, [phone, lookupTokenHash])
    s.json({ lookupToken, expiresInHours: 24 })
  } catch (e) { next(e) }
})

app.get('/api/orders/lookup', async (q, s, next) => {
  const lookupToken = String(q.get('x-lookup-token') || '')
  if (!lookupToken || lookupToken.length < 32) return s.status(401).json({ error: 'Phone verification required' })
  const lookupTokenHash = crypto.createHash('sha256').update(lookupToken).digest('hex')
  try {
    const session = await pool.query(`SELECT phone FROM guest_lookup_sessions WHERE token_hash=$1 AND expires_at>CURRENT_TIMESTAMP`, [lookupTokenHash])
    if (!session.rows.length) return s.status(401).json({ error: 'Verification expired or invalid' })
    const phone = session.rows[0].phone
    const orders = await pool.query(`SELECT o.id,o.order_number,o.status,o.total_bdt,o.created_at,
      COALESCE((SELECT json_agg(json_build_object('name',oi.product_name_snapshot,'quantity',oi.quantity,'lineTotal',oi.line_total_bdt) ORDER BY oi.id)
      FROM order_items oi WHERE oi.order_id=o.id),'[]'::json) AS items
      FROM orders o WHERE o.phone=$1 ORDER BY o.created_at DESC LIMIT 50`, [phone])
    s.json(orders.rows.map(row => ({ id:Number(row.id), orderNumber:row.order_number, status:row.status, total:Number(row.total_bdt), createdAt:row.created_at, items:row.items })))
  } catch (e) { next(e) }
})

app.get('/api/orders/lookup/:id', async (q, s, next) => {
  const lookupToken = String(q.get('x-lookup-token') || '')
  const lookupTokenHash = crypto.createHash('sha256').update(lookupToken).digest('hex')
  try {
    const session = await pool.query(`SELECT phone FROM guest_lookup_sessions WHERE token_hash=$1 AND expires_at>CURRENT_TIMESTAMP`, [lookupTokenHash])
    if (!session.rows.length) return s.status(401).json({ error: 'Verification expired or invalid' })
    const orderResult = await pool.query(`SELECT o.id,o.order_number,o.contact_name,o.phone,o.address_line,o.district,o.status,
      o.subtotal_bdt,o.delivery_bdt,o.total_bdt,o.currency,o.created_at,
      COALESCE((SELECT json_agg(json_build_object('name',oi.product_name_snapshot,'sku',oi.sku_snapshot,'variant',COALESCE(oi.variant_name_snapshot,''),'quantity',oi.quantity,'unitPrice',oi.unit_price_bdt_snapshot,'lineTotal',oi.line_total_bdt) ORDER BY oi.id) FROM order_items oi WHERE oi.order_id=o.id),'[]'::json) AS items,
      COALESCE((SELECT json_agg(json_build_object('status',osh.new_status,'reason',osh.reason,'createdAt',osh.created_at) ORDER BY osh.created_at,osh.id) FROM order_status_history osh WHERE osh.order_id=o.id),'[]'::json) AS history
      FROM orders o WHERE o.id=$1 AND o.phone=$2`, [q.params.id, session.rows[0].phone])
    if (!orderResult.rows.length) return s.status(404).json({ error: 'Order not found' })
    const row = orderResult.rows[0]
    const payment = await pool.query(`SELECT provider,method,status,amount_bdt FROM payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1`, [q.params.id])
    s.json({ id:Number(row.id),orderNumber:row.order_number,status:row.status,createdAt:row.created_at,customer:{name:row.contact_name,phone:row.phone,address:row.address_line,district:row.district},items:row.items,subtotal:Number(row.subtotal_bdt),delivery:Number(row.delivery_bdt),total:Number(row.total_bdt),currency:row.currency,payment:payment.rows[0] ? { ...payment.rows[0],amount:Number(payment.rows[0].amount_bdt)} : null,history:row.history })
  } catch (e) { next(e) }
})

app.post('/api/orders', async (q, s, next) => {
  const { name, phone, address, district, items } = q.body || {}
  if (!name || !address || !/^01[3-9]\d{8}$/.test(phone || '') || !Array.isArray(items) || !items.length) {
    return s.status(400).json({ error: 'Name, a valid phone (01XXXXXXXXX), address and items are required' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let subtotal = 0
    const lines = []

    for (const item of items) {
      if (!Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > 1000000) {
        throw new Error('Invalid item in cart')
      }
      const size = String(item.size || '').trim()
      const variantResult = await client.query(`
        SELECT pv.id,p.id AS product_id,p.name,p.base_price_bdt AS price,
               i.quantity_on_hand-i.reserved_quantity AS available
        FROM product_variants pv
        JOIN products p ON p.id=pv.product_id
        JOIN inventory i ON i.product_variant_id=pv.id
        JOIN product_variant_attribute_values pvav ON pvav.product_variant_id=pv.id
        JOIN variant_attribute_values vav ON vav.id=pvav.attribute_value_id
        JOIN variant_attributes va ON va.id=vav.attribute_id AND va.code='size'
        WHERE p.id=$1 AND p.status='active' AND pv.is_active=TRUE
          AND ($2='' OR vav.value=$2)
        ORDER BY pv.id LIMIT 1 FOR UPDATE OF pv, i`, [item.id, size])

      if (!variantResult.rows.length) throw new Error('Invalid item or size in cart')
      const variant = variantResult.rows[0]
      if (Number(variant.available) < item.qty) throw new Error(`${variant.name} has only ${variant.available} left`)

      subtotal += Number(variant.price) * item.qty
      lines.push({ productId: Number(variant.product_id), variantId: Number(variant.id), name: variant.name, size, qty: item.qty, price: Number(variant.price) })
    }

    const delivery = district === 'Dhaka' ? 60 : 120
    const total = subtotal + delivery
    const orderNumber = 'POS-' + crypto.randomUUID().slice(0, 12).toUpperCase()
    const trackingToken = crypto.randomBytes(24).toString('base64url')
    const trackingTokenHash = crypto.createHash('sha256').update(trackingToken).digest('hex')
    const orderResult = await client.query(`
      INSERT INTO orders(order_number,guest_tracking_token_hash,contact_name,phone,address_line,district,status,subtotal_bdt,delivery_bdt,total_bdt,currency)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,'BDT') RETURNING id,order_number`,
      [orderNumber, trackingTokenHash, String(name).trim(), phone.trim(), String(address).trim(), String(district || '').trim(), subtotal, delivery, total])
    const orderId = orderResult.rows[0].id

    for (const line of lines) {
      const inventoryUpdate = await client.query(`
        UPDATE inventory SET quantity_on_hand=quantity_on_hand-$1,updated_at=CURRENT_TIMESTAMP
        WHERE product_variant_id=$2 AND quantity_on_hand-reserved_quantity >= $1
        RETURNING product_variant_id`, [line.qty, line.variantId])
      if (!inventoryUpdate.rows.length) throw new Error(`${line.name} has insufficient stock`)
      const skuResult = await client.query('SELECT sku FROM product_variants WHERE id=$1', [line.variantId])
      await client.query(`
        INSERT INTO order_items(order_id,product_id,product_variant_id,product_name_snapshot,sku_snapshot,variant_name_snapshot,unit_price_bdt_snapshot,quantity,line_total_bdt)
        VALUES($1,$2,$3,$4,$5,$6,$7::bigint,$8::integer,$7::bigint*$8::integer)`,
        [orderId, line.productId, line.variantId, line.name, skuResult.rows[0]?.sku || null, line.size, line.price, line.qty])
    }

    await client.query(`INSERT INTO payments(order_id,provider,method,status,amount_bdt) VALUES($1,'cod','cash_on_delivery','pending',$2)`, [orderId, total])
    await client.query(`INSERT INTO order_status_history(order_id,previous_status,new_status,reason) VALUES($1,NULL,'pending','Created by checkout')`, [orderId])
    await client.query('COMMIT')
    s.json({ id: Number(orderId), orderNumber: orderResult.rows[0].order_number, trackingToken })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

app.get('/api/orders/:id/track', async (q, s, next) => {
  const trackingToken = String(q.query.token || '')
  if (!trackingToken || trackingToken.length < 32) return s.status(403).json({ error: 'Invalid tracking token' })
  const tokenHash = crypto.createHash('sha256').update(trackingToken).digest('hex')
  try {
    const orderResult = await pool.query(`
      SELECT o.id,o.order_number,o.contact_name,o.phone,o.address_line,o.district,o.status,
             o.subtotal_bdt,o.delivery_bdt,o.total_bdt,o.currency,o.created_at,
             COALESCE((SELECT json_agg(json_build_object(
               'name',oi.product_name_snapshot,'sku',oi.sku_snapshot,
               'variant',COALESCE(oi.variant_name_snapshot,''),'quantity',oi.quantity,
               'unitPrice',oi.unit_price_bdt_snapshot,'lineTotal',oi.line_total_bdt)
               ORDER BY oi.id) FROM order_items oi WHERE oi.order_id=o.id),'[]'::json) AS items,
             COALESCE((SELECT json_agg(json_build_object('status',osh.new_status,'reason',osh.reason,'createdAt',osh.created_at)
               ORDER BY osh.created_at,osh.id) FROM order_status_history osh WHERE osh.order_id=o.id),'[]'::json) AS history
      FROM orders o WHERE o.id=$1 AND o.guest_tracking_token_hash=$2`, [q.params.id, tokenHash])
    if (!orderResult.rows.length) return s.status(404).json({ error: 'Order not found' })
    const payment = await pool.query("SELECT provider,method,status,amount_bdt FROM payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1", [q.params.id])
    const row = orderResult.rows[0]
    s.json({
      id:Number(row.id),orderNumber:row.order_number,status:row.status,createdAt:row.created_at,
      customer:{name:row.contact_name,phone:row.phone,address:row.address_line,district:row.district},
      items:row.items,subtotal:Number(row.subtotal_bdt),delivery:Number(row.delivery_bdt),total:Number(row.total_bdt),currency:row.currency,
      payment:payment.rows[0] ? {...payment.rows[0],amount:Number(payment.rows[0].amount_bdt)} : null,history:row.history
    })
  } catch (e) { next(e) }
})

async function restoreCancelledOrder(client, orderId, reason) {
  const items = await client.query(`SELECT product_variant_id,quantity FROM order_items WHERE order_id=$1 AND product_variant_id IS NOT NULL`, [orderId])
  for (const item of items.rows) {
    await client.query(`UPDATE inventory SET quantity_on_hand=quantity_on_hand+$1,updated_at=CURRENT_TIMESTAMP WHERE product_variant_id=$2`, [item.quantity,item.product_variant_id])
  }
  await client.query(`UPDATE payments SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE order_id=$1 AND status='pending'`, [orderId])
}

app.post('/api/orders/:id/cancel', async (q,s,next) => {
  const trackingToken = String(q.body?.token || q.query.token || '')
  const reason = String(q.body?.reason || 'Customer cancellation').trim().slice(0,500)
  if (trackingToken.length < 32) return s.status(403).json({ error:'Invalid tracking token' })
  const tokenHash = crypto.createHash('sha256').update(trackingToken).digest('hex')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query(`SELECT id,status FROM orders WHERE id=$1 AND guest_tracking_token_hash=$2 FOR UPDATE`, [q.params.id,tokenHash])
    if (!current.rows.length) {
      await client.query('ROLLBACK')
      return s.status(404).json({ error:'Order not found' })
    }
    const previous = current.rows[0].status
    if (previous === 'cancelled') {
      await client.query('ROLLBACK')
      return s.status(409).json({ error:'Order is already cancelled' })
    }
    if (!['pending','confirmed'].includes(previous)) {
      await client.query('ROLLBACK')
      return s.status(409).json({ error:'This order can no longer be cancelled' })
    }
    await restoreCancelledOrder(client,q.params.id,reason)
    await client.query(`UPDATE orders SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [q.params.id])
    await client.query(`INSERT INTO order_status_history(order_id,previous_status,new_status,reason) VALUES($1,$2,'cancelled',$3)`, [q.params.id,previous,reason])
    await client.query('COMMIT')
    s.json({ ok:true,status:'cancelled' })
  } catch(e) { await client.query('ROLLBACK').catch(()=>{}); next(e) } finally { client.release() }
})

app.get('/api/admin/orders', admin, async (q, s, next) => {
  try {
    const result = await pool.query(`SELECT o.id,o.order_number,o.contact_name AS name,o.phone,o.address_line AS address,o.district,
      COALESCE((SELECT json_agg(json_build_object('name',oi.product_name_snapshot,'size',COALESCE(oi.variant_name_snapshot,''),'qty',oi.quantity,'price',oi.unit_price_bdt_snapshot,'lineTotal',oi.line_total_bdt)) FROM order_items oi WHERE oi.order_id=o.id),'[]')::text AS items,
      o.subtotal_bdt AS subtotal,o.delivery_bdt AS delivery,o.total_bdt AS total,
      CASE WHEN o.status='pending' THEN 'new' ELSE o.status END AS status,o.created_at AS created
      FROM orders o ORDER BY o.id DESC`)
    s.json(result.rows)
  } catch (e) { next(e) }
})

app.patch('/api/admin/orders/:id', admin, async (q, s, next) => {
  const raw = String(q.body.status || '').trim().toLowerCase()
  const status = raw === 'new' ? 'pending' : raw
  if (!['pending','confirmed','shipped','delivered','cancelled','returned'].includes(status)) return s.status(400).json({ error: 'Invalid order status' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [q.params.id])
    if (!current.rows.length) {
      await client.query('ROLLBACK')
      return s.status(404).json({ error: 'Order not found' })
    }
    const previous = current.rows[0].status
    if (status === previous) {
      await client.query('ROLLBACK')
      return s.json({ ok: 1, unchanged: true })
    }
    if (status === 'cancelled' && !['pending','confirmed'].includes(previous)) {
      await client.query('ROLLBACK')
      return s.status(409).json({ error:'Cannot restore stock for this order status' })
    }
    if (status === 'cancelled') await restoreCancelledOrder(client,q.params.id,'Admin cancellation')
    await client.query(`UPDATE orders SET status=$1,cancelled_at=CASE WHEN $1='cancelled' THEN CURRENT_TIMESTAMP ELSE cancelled_at END,updated_at=CURRENT_TIMESTAMP WHERE id=$2`, [status, q.params.id])
    await client.query('INSERT INTO order_status_history(order_id,previous_status,new_status,reason) VALUES($1,$2,$3,$4)', [q.params.id,previous,status,'Admin status update'])
    await client.query('COMMIT')
    s.json({ ok: 1 })
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); next(e) } finally { client.release() }
})

app.get('/api/admin/products', admin, async (q, s, next) => {
  try { s.json(await productFlatRows(pool, "WHERE p.status='active'")) } catch (e) { next(e) }
})

app.post('/api/admin/products', admin, upload.single('imageFile'), async (q, s, next) => {
  const b = q.body
  const name = String(b.name || '').trim()
  const price = Number(b.price)
  const stock = Number(b.stock || 0)
  if (!name || !Number.isSafeInteger(price) || price < 0 || price > 1000000000 || !Number.isSafeInteger(stock) || stock < 0) {
    return s.status(400).json({ error: 'Invalid product details' })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const categoryName = String(b.category || 'Uncategorized').trim() || 'Uncategorized'
    const categorySlug = slugify(categoryName)
    const category = await client.query(`INSERT INTO categories(name,slug) VALUES($1,$2)
      ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name,updated_at=CURRENT_TIMESTAMP RETURNING id`, [categoryName, categorySlug])
    const image = q.file ? '/uploads/' + q.file.filename : String(b.image || '')
    const slug = slugify(name) + '-' + crypto.randomUUID().slice(0, 8)
    const product = await client.query(`INSERT INTO products(category_id,name,slug,base_price_bdt,status,image_url_or_key,legacy_stock)
      VALUES($1,$2,$3,$4,'active',$5,$6) RETURNING id`, [category.rows[0].id,name,slug,price,image,stock])
    await syncProductVariants(client, product.rows[0].id, b.sizes, stock)
    await client.query('COMMIT')
    s.json({ ok: 1, id: Number(product.rows[0].id) })
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); next(e) } finally { client.release() }
})

app.patch('/api/admin/products/:id', admin, upload.single('imageFile'), async (q, s, next) => {
  const b = q.body
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query(`SELECT p.*,c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=$1 AND p.status='active' FOR UPDATE OF p`, [q.params.id])
    if (!current.rows.length) return s.status(404).json({ error: 'Product not found' })
    const old = current.rows[0]
    const name = String(b.name || old.name).trim()
    const categoryName = String(b.category || old.category || 'Uncategorized').trim() || 'Uncategorized'
    const price = b.price === '' || b.price == null ? Number(old.base_price_bdt) : Number(b.price)
    const stock = b.stock === '' || b.stock == null ? Number(old.legacy_stock) : Number(b.stock)
    if (!name || !Number.isSafeInteger(price) || price < 0 || price > 1000000000 || !Number.isSafeInteger(stock) || stock < 0) {
      return s.status(400).json({ error: 'Invalid product details' })
    }
    const category = await client.query(`INSERT INTO categories(name,slug) VALUES($1,$2)
      ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name,updated_at=CURRENT_TIMESTAMP RETURNING id`, [categoryName, slugify(categoryName)])
    const image = q.file ? '/uploads/' + q.file.filename : String(b.image == null || b.image === '__KEEP__' ? old.image_url_or_key || '' : b.image)
    await client.query(`UPDATE products SET category_id=$1,name=$2,base_price_bdt=$3,image_url_or_key=$4,legacy_stock=$5,updated_at=CURRENT_TIMESTAMP WHERE id=$6`, [category.rows[0].id,name,price,image,stock,q.params.id])
    await syncProductVariants(client, q.params.id, b.sizes || '', stock)
    await client.query('COMMIT')
    s.json({ ok: 1 })
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); next(e) } finally { client.release() }
})

app.delete('/api/admin/products/:id', admin, async (q, s, next) => {
  try {
    await pool.query(`UPDATE products SET status='archived',archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [q.params.id])
    await pool.query('UPDATE product_variants SET is_active=FALSE,updated_at=CURRENT_TIMESTAMP WHERE product_id=$1', [q.params.id])
    s.json({ ok: 1 })
  } catch (e) { next(e) }
})

app.use((e, q, s, n) => {
  console.error('API error:', e.message)
  s.status(400).json({ error: e.message || 'Request failed' })
})

app.get('*', (q, s) => {
  if (q.path.startsWith('/api/')) return s.status(404).json({ error: 'Not found' })
  s.sendFile(path.resolve('client/dist/index.html'))
})

pool.query('SELECT 1')
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('Poshak running on PostgreSQL port ' + (process.env.PORT || 3000))))
  .catch(e => { console.error('PostgreSQL connection failed:', e.message); process.exit(1) })
