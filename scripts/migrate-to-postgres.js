const crypto = require('node:crypto')
const fs = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const { Client } = require('pg')

const dryRun = process.argv.includes('--dry-run')
const apply = process.argv.includes('--apply')
if (!dryRun && !apply) {
  console.error('Usage: node scripts/migrate-to-postgres.js --dry-run | --apply')
  process.exit(2)
}

function slugify(value) {
  return String(value || 'uncategorized')
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'uncategorized'
}

function normalizeOrderStatus(value) {
  const status = String(value || 'new').toLowerCase().trim()
  if (status === 'new') return 'pending'
  if (['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned'].includes(status)) return status
  throw new Error(`Unsupported legacy order status: ${value}`)
}

function safeInteger(value, label, max = 1000000000) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 0 || Number(value) > max) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return Number(value)
}

async function migrate() {
  const sqlitePath = process.env.DB_PATH || 'store.db'
  if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite source not found: ${sqlitePath}`)

  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sqlitePath)).digest('hex')
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true })
  const products = sqlite.prepare('SELECT * FROM products ORDER BY id').all()
  const orders = sqlite.prepare('SELECT * FROM orders ORDER BY id').all()

  for (const product of products) {
    safeInteger(product.id, `product ${product.id} id`)
    safeInteger(product.price, `product ${product.id} price`)
    safeInteger(product.stock, `product ${product.id} stock`)
  }
  for (const order of orders) {
    for (const field of ['subtotal', 'delivery', 'total']) safeInteger(order[field], `order ${order.id} ${field}`)
    if (safeInteger(order.subtotal, 'subtotal') + safeInteger(order.delivery, 'delivery') !== safeInteger(order.total, 'total')) {
      throw new Error(`Order ${order.id} total does not equal subtotal plus delivery`)
    }
  }

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL migration')
  const postgres = new Client({ connectionString })
  await postgres.connect()

  const report = { source: sqlitePath, sourceSha256: sourceHash, sourceProductCount: products.length, sourceOrderCount: orders.length, dryRun, warnings: [], stats: {} }
  try {
    await postgres.query('BEGIN')

    const completed = await postgres.query(
      `SELECT id, report FROM migration_runs WHERE source_name=$1 AND source_sha256=$2 AND status='completed' ORDER BY id DESC LIMIT 1`,
      [sqlitePath, sourceHash]
    )
    if (completed.rows.length && apply) {
      await postgres.query('ROLLBACK')
      console.log(JSON.stringify({ status: 'already-migrated', migrationRunId: completed.rows[0].id, report: completed.rows[0].report }, null, 2))
      return
    }

    await postgres.query(`INSERT INTO variant_attributes(name, code, sort_order)
      VALUES ('Size','size',10),('Color','color',20)
      ON CONFLICT(code) DO NOTHING`)

    const categoryByName = new Map()
    for (const product of products) {
      const name = String(product.category || 'Uncategorized').trim() || 'Uncategorized'
      if (categoryByName.has(name)) continue
      const r = await postgres.query(
        `INSERT INTO categories(name,slug)
         VALUES($1,$2)
         ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name, updated_at=CURRENT_TIMESTAMP
         RETURNING id`, [name, slugify(name)])
      categoryByName.set(name, r.rows[0].id)
    }

    let orderItemCount = 0
    for (const product of products) {
      const productSlug = `legacy-${product.id}-${slugify(product.name)}`
      const existing = await postgres.query('SELECT id,name,base_price_bdt,slug FROM products WHERE id=$1 OR slug=$2 LIMIT 1', [product.id, productSlug])
      if (existing.rows.length && (existing.rows[0].name !== product.name.trim() || Number(existing.rows[0].base_price_bdt) !== Number(product.price))) {
        throw new Error(`Product ID/slug ${product.id}/${productSlug} conflicts with an existing PostgreSQL product`)
      }
      const categoryName = String(product.category || 'Uncategorized').trim() || 'Uncategorized'
      await postgres.query(
        `INSERT INTO products(id,category_id,name,slug,base_price_bdt,status,image_url_or_key,legacy_stock,archived_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(id) DO NOTHING`,
        [product.id, categoryByName.get(categoryName), product.name.trim(), productSlug, Number(product.price), Number(product.active) ? 'active' : 'archived', product.image || null, Number(product.stock), Number(product.active) ? null : new Date().toISOString()]
      )

      const sizeNames = [...new Set(String(product.sizes || 'One Size').split(',').map(v => v.trim()).filter(Boolean))]
      if (!sizeNames.length) sizeNames.push('One Size')
      const stock = Number(product.stock)
      const base = Math.floor(stock / sizeNames.length)
      const remainder = stock % sizeNames.length

      for (let index = 0; index < sizeNames.length; index++) {
        const size = sizeNames[index]
        const allocation = base + (index < remainder ? 1 : 0)
        const sku = `LEGACY-${product.id}-${slugify(size)}`.toUpperCase()
        const variantResult = await postgres.query(
          `INSERT INTO product_variants(product_id,sku,is_active)
           VALUES($1,$2,TRUE)
           ON CONFLICT(sku) DO UPDATE SET product_id=EXCLUDED.product_id,is_active=TRUE,updated_at=CURRENT_TIMESTAMP
           RETURNING id`, [product.id, sku]
        )
        const variantId = variantResult.rows[0].id

        for (const attribute of [['size', size], ['color', 'Not specified']]) {
          const [code, value] = attribute
          const valueResult = await postgres.query(
            `INSERT INTO variant_attribute_values(attribute_id,value)
             SELECT id,$2 FROM variant_attributes WHERE code=$1
             ON CONFLICT(attribute_id,value) DO UPDATE SET value=EXCLUDED.value
             RETURNING id`, [code, value]
          )
          await postgres.query(
            `INSERT INTO product_variant_attribute_values(product_variant_id,attribute_value_id)
             VALUES($1,$2) ON CONFLICT DO NOTHING`, [variantId, valueResult.rows[0].id]
          )
        }

        await postgres.query(
          `INSERT INTO inventory(product_variant_id,quantity_on_hand,reserved_quantity)
           VALUES($1,$2,0)
           ON CONFLICT(product_variant_id) DO UPDATE SET quantity_on_hand=EXCLUDED.quantity_on_hand,reserved_quantity=0,updated_at=CURRENT_TIMESTAMP`,
          [variantId, allocation]
        )
      }
    }

    for (const order of orders) {
      await postgres.query(
        `INSERT INTO orders(id,order_number,contact_name,phone,address_line,district,status,subtotal_bdt,delivery_bdt,total_bdt,currency,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'BDT',$11)
         ON CONFLICT(id) DO NOTHING`,
        [order.id, `LEGACY-${order.id}`, String(order.name || 'Guest').trim() || 'Guest', String(order.phone || '').trim(), String(order.address || '').trim(), String(order.district || 'Unknown').trim(), normalizeOrderStatus(order.status), Number(order.subtotal), Number(order.delivery), Number(order.total), order.created || new Date().toISOString()]
      )

      let items = []
      try { items = JSON.parse(order.items || '[]') } catch {
        report.warnings.push(`Order ${order.id} has invalid items JSON; item snapshots could not be migrated`)
      }
      if (!Array.isArray(items)) items = []

      for (const item of items) {
        const quantity = safeInteger(item.qty, `order ${order.id} item quantity`, 1000000)
        if (quantity === 0) throw new Error(`Order ${order.id} has zero item quantity`)
        const unitPrice = safeInteger(item.price, `order ${order.id} item price`)
        const size = String(item.size || 'One Size')
        const matchingProduct = products.find(p => String(p.name) === String(item.name))
        const sku = matchingProduct ? `LEGACY-${matchingProduct.id}-${slugify(size)}`.toUpperCase() : null
        const variant = sku ? await postgres.query('SELECT id FROM product_variants WHERE sku=$1', [sku]) : { rows: [] }
        await postgres.query(
          `INSERT INTO order_items(order_id,product_id,product_variant_id,product_name_snapshot,sku_snapshot,variant_name_snapshot,unit_price_bdt_snapshot,quantity,line_total_bdt)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
           WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE order_id=$1 AND product_name_snapshot=$4 AND quantity=$8 AND unit_price_bdt_snapshot=$7)`,
          [order.id, matchingProduct ? matchingProduct.id : null, variant.rows[0]?.id || null, String(item.name || 'Unknown product'), sku, size, unitPrice, quantity, unitPrice * quantity]
        )
        orderItemCount += 1
      }

      await postgres.query(
        `INSERT INTO payments(order_id,provider,method,status,amount_bdt)
         SELECT $1,'cod','cash_on_delivery','pending',$2
         WHERE NOT EXISTS (SELECT 1 FROM payments WHERE order_id=$1 AND provider='cod')`, [order.id, Number(order.total)]
      )
      await postgres.query(
        `INSERT INTO order_status_history(order_id,previous_status,new_status,reason)
         VALUES($1,NULL,$2,'Imported from legacy SQLite')`, [order.id, normalizeOrderStatus(order.status)]
      )
    }

    await postgres.query("SELECT setval(pg_get_serial_sequence('products','id'), COALESCE((SELECT MAX(id) FROM products), 1), true)")
    await postgres.query("SELECT setval(pg_get_serial_sequence('orders','id'), COALESCE((SELECT MAX(id) FROM orders), 1), true)")

    const validation = await postgres.query(`
      SELECT
        (SELECT count(*) FROM products) target_product_count,
        (SELECT count(*) FROM orders) target_order_count,
        (SELECT COALESCE(sum(quantity_on_hand),0) FROM inventory) inventory_total,
        (SELECT count(*) FROM order_items) target_order_item_count,
        (SELECT count(*) FROM orders WHERE total_bdt <> subtotal_bdt + delivery_bdt) invalid_order_total_count
    `)
    report.stats = validation.rows[0]
    report.stats.sourceStockTotal = products.reduce((sum, p) => sum + Number(p.stock), 0)

    if (Number(report.stats.invalid_order_total_count) !== 0) throw new Error('Target order total validation failed')
    if (Number(report.stats.inventory_total) !== Number(report.stats.sourceStockTotal)) {
      throw new Error(`Migrated inventory total ${report.stats.inventory_total} does not match source stock total ${report.stats.sourceStockTotal}`)
    }

    const migrationRun = await postgres.query(
      `INSERT INTO migration_runs(source_name,source_sha256,source_product_count,source_order_count,target_product_count,target_order_count,status,report)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING id`, [sqlitePath, sourceHash, products.length, orders.length, Number(report.stats.target_product_count), Number(report.stats.target_order_count), dryRun ? 'completed' : 'completed', JSON.stringify(report)]
    )

    if (dryRun) {
      await postgres.query('ROLLBACK')
    } else {
      await postgres.query('COMMIT')
    }
    console.log(JSON.stringify({ status: dryRun ? 'dry-run-valid' : 'completed', migrationRunId: migrationRun.rows[0]?.id, report }, null, 2))
  } catch (error) {
    await postgres.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await postgres.end()
    sqlite.close()
  }
}

migrate().catch(error => {
  console.error(error.message)
  process.exit(1)
})
