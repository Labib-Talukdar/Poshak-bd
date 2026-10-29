require('dotenv').config()
const fs = require('node:fs')
const { Pool } = require('pg')

async function initialize() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false
  })
  try {
    const sql = fs.readFileSync('postgres-schema.sql', 'utf8')
    await pool.query(sql)
    console.log('PostgreSQL schema initialized')
  } finally {
    await pool.end()
  }
}

initialize().catch(error => {
  console.error(error.message)
  process.exit(1)
})
