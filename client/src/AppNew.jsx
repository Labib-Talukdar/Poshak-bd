import { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeftIcon, ArrowRightIcon, HeartIcon, MagnifyingGlassIcon, MinusIcon, PlusIcon, ShoppingBagIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { HeartIcon as HeartSolidIcon } from '@heroicons/react/24/solid'
import { motion } from 'framer-motion'
import './styles.css'

const reloopLogo = '/reloop-logo.png'
const reloopBrandKit = '/reloop-loader.png'

const money = (value) => `৳${Number(value).toLocaleString('en-IN')}`
const readOrderHistory = () => {
  try { return JSON.parse(localStorage.getItem('poshak-order-history') || '[]') } catch { return [] }
}

function Storefront() {
  const [products, setProducts] = useState([])
  const [category, setCategory] = useState('All')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('featured')
  const [inStockOnly, setInStockOnly] = useState(false)
  const [wishlist, setWishlist] = useState(() => JSON.parse(localStorage.getItem('poshak-wishlist') || '[]'))
  const [wishlistOnly, setWishlistOnly] = useState(false)
  const [cart, setCart] = useState(() => JSON.parse(localStorage.getItem('poshak-cart') || '[]'))
  const [cartOpen, setCartOpen] = useState(false)
  const [ordersOpen, setOrdersOpen] = useState(false)
  const [orderHistory, setOrderHistory] = useState([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [lookupPhone, setLookupPhone] = useState('')
  const [lookupOtp, setLookupOtp] = useState('')
  const [lookupChallenge, setLookupChallenge] = useState(null)
  const [lookupMessage, setLookupMessage] = useState('')
  const [lookupLoading, setLookupLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => { localStorage.setItem('poshak-cart', JSON.stringify(cart)) }, [cart])
  useEffect(() => { localStorage.setItem('poshak-wishlist', JSON.stringify(wishlist)) }, [wishlist])
  useEffect(() => {
    fetch('/api/products').then(r => r.json()).then(data => setProducts(data)).finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    if (!ordersOpen) return
    const saved = readOrderHistory()
    setOrdersLoading(true)
    Promise.all(saved.map(async entry => {
      try {
        const response = await fetch(`/api/orders/${entry.id}/track?token=${encodeURIComponent(entry.trackingToken)}`)
        if (!response.ok) return entry
        const order = await response.json()
        return { ...entry, ...order }
      } catch { return entry }
    })).then(data => setOrderHistory(data)).finally(() => setOrdersLoading(false))
  }, [ordersOpen])

  const categories = ['All', ...new Set(products.map(p => p.category))]
  const visible = useMemo(() => {
    const result = products.filter(p =>
      (category === 'All' || p.category === category) &&
      p.name.toLowerCase().includes(query.trim().toLowerCase()) &&
      (!inStockOnly || p.stock > 0) &&
      (!wishlistOnly || wishlist.includes(p.id))
    )
    if (sort === 'low') return [...result].sort((a, b) => a.price - b.price)
    if (sort === 'high') return [...result].sort((a, b) => b.price - a.price)
    if (sort === 'name') return [...result].sort((a, b) => a.name.localeCompare(b.name))
    return result
  }, [products, category, query, inStockOnly, wishlistOnly, wishlist, sort])

  const add = (product) => {
    if (product.stock < 1) return
    const size = product.sizes?.split(',')[0] || 'Free'
    setCart(old => {
      const found = old.find(i => i.id === product.id && i.size === size)
      if (found) return old.map(i => i === found ? { ...i, qty: Math.min(product.stock, i.qty + 1) } : i)
      return [...old, { id: product.id, size, qty: 1 }]
    })
    setCartOpen(true)
  }
  const changeQty = (index, delta) => setCart(old => old.map((item, i) => {
    if (i !== index) return item
    const product = products.find(p => p.id === item.id)
    const totalForProduct = old.filter(row => row.id === item.id).reduce((sum, row) => sum + row.qty, 0)
    const otherQty = totalForProduct - item.qty
    const maxQty = Math.max(1, (product?.stock || 1) - otherQty)
    return { ...item, qty: Math.max(0, Math.min(maxQty, item.qty + delta)) }
  }).filter(item => item.qty > 0))
  const toggleWishlist = id => setWishlist(old => old.includes(id) ? old.filter(value => value !== id) : [...old, id])
  const cartCount = cart.reduce((sum, item) => sum + item.qty, 0)
  const subtotal = cart.reduce((sum, item) => sum + (products.find(p => p.id === item.id)?.price || 0) * item.qty, 0)

  const requestPhoneOtp = async event => {
    event.preventDefault()
    setLookupLoading(true)
    setLookupMessage('')
    try {
      const response = await fetch('/api/orders/lookup/request', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ phone: lookupPhone }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not send OTP')
      setLookupChallenge(data)
      setLookupMessage(data.devOtp ? `Development OTP: ${data.devOtp}` : 'OTP has been sent. Check your phone.')
    } catch (error) { setLookupMessage(error.message) }
    finally { setLookupLoading(false) }
  }

  const verifyPhoneOtp = async event => {
    event.preventDefault()
    setLookupLoading(true)
    setLookupMessage('')
    try {
      const response = await fetch('/api/orders/lookup/verify', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ phone: lookupPhone, otp: lookupOtp, challengeId: lookupChallenge?.challengeId }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not verify OTP')
      localStorage.setItem('poshak-guest-lookup-token', data.lookupToken)
      const listResponse = await fetch('/api/orders/lookup', { headers: { 'x-lookup-token': data.lookupToken } })
      const orders = await listResponse.json()
      if (!listResponse.ok) throw new Error(orders.error || 'Could not load orders')
      setOrderHistory(orders.map(order => ({ ...order, trackingToken:'' })))
      setLookupMessage(`${orders.length} order${orders.length === 1 ? '' : 's'} found`)
      setLookupOtp('')
    } catch (error) { setLookupMessage(error.message) }
    finally { setLookupLoading(false) }
  }

  return <>
    <header className="site-header">
      <a className="logo" href="#top" aria-label="Reloop home"><img className="brand-logo" src={reloopLogo} alt="Reloop"/></a>
      <nav aria-label="Primary navigation"><a href="#shop">Shop</a><a href="#story">Our story</a></nav>
      <div className="header-actions"><button className="orders-button" onClick={() => setOrdersOpen(true)} aria-label="View my orders">My orders</button><button className={`wishlist-button ${wishlistOnly ? 'active' : ''}`} onClick={() => { setWishlistOnly(value => !value); document.querySelector('#shop')?.scrollIntoView({ behavior: 'smooth' }) }} aria-label={`Show wishlist, ${wishlist.length} items`}>{wishlistOnly ? <HeartSolidIcon/> : <HeartIcon/>}<b>{wishlist.length}</b></button><button className="cart-button" onClick={() => setCartOpen(true)} aria-label={`Open cart, ${cartCount} items`}><ShoppingBagIcon className="icon"/><span>Cart</span><b>{cartCount}</b></button></div>
    </header>

    <main id="top">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow"><span></span> New collection · 2026</p>
          <h1>Dress like<br/><em>yourself.</em></h1>
          <p className="hero-description">Thoughtful everyday wear for moments big and small. Comfortable, considered, unmistakably you.</p>
          <a className="primary-button" href="#shop">Explore collection <ArrowRightIcon className="icon"/></a>
        </div>
        <div className="hero-art" aria-label="Featured collection">
          <div className="art-frame"><div className="art-mark">P</div></div>
          <div className="art-caption"><span>01</span><p>New season<br/>Essentials</p></div>
        </div>
      </section>

      <section className="shop-section" id="shop">
        <div className="section-heading"><div><p className="eyebrow"><span></span> Curated for you</p><h2>Shop the collection</h2></div><label className="search"><MagnifyingGlassIcon className="icon"/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search" aria-label="Search products"/></label></div>
        <div className="category-row" role="tablist">{categories.map(name => <button key={name} role="tab" aria-selected={category === name} className={category === name ? 'active' : ''} onClick={() => setCategory(name)}>{name}</button>)}</div>
        <div className="shop-controls"><button className={inStockOnly ? 'filter-active' : ''} onClick={() => setInStockOnly(value => !value)}>In stock only</button><label>Sort<select value={sort} onChange={e => setSort(e.target.value)}><option value="featured">Featured</option><option value="low">Price: low to high</option><option value="high">Price: high to low</option><option value="name">Name</option></select></label></div>
        {loading ? <div className="product-grid">{[1,2,3,4].map(n => <div className="skeleton" key={n}/>)}</div> :
          <div className="product-grid">{visible.map(product => <article className="product-card" key={product.id} onClick={() => navigate(`/product/${product.id}`)} role="link" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') navigate(`/product/${product.id}`) }}>
            <Link className="product-image-link" to={`/product/${product.id}`} aria-label={`View ${product.name}`}><div className="product-image">
              {product.image ? <img src={product.image} alt={product.name}/> : <div className="monogram" style={{ '--tone': `${product.id * 47 % 360}` }}>{product.name.charAt(0)}</div>}
              <button className={`card-wishlist ${wishlist.includes(product.id) ? 'saved' : ''}`} onClick={event => { event.stopPropagation(); toggleWishlist(product.id) }} aria-label={wishlist.includes(product.id) ? 'Remove from wishlist' : 'Add to wishlist'}>{wishlist.includes(product.id) ? <HeartSolidIcon/> : <HeartIcon/>}</button>
              <span className="stock-label">{product.stock > 0 ? 'In stock' : 'Sold out'}</span>
            </div></Link>
            <div className="product-info"><div><p>{product.category}</p><Link className="product-title-link" to={`/product/${product.id}`}><h3>{product.name}</h3></Link><strong className="product-price">{money(product.price)}</strong></div><button onClick={event => { event.stopPropagation(); add(product) }} disabled={product.stock < 1} aria-label={`Add ${product.name} to cart`}><PlusIcon className="icon"/></button></div>
          </article>)}</div>
        }
        {!loading && visible.length === 0 && <div className="empty-products"><h3>No products found</h3><p>Try another search or category.</p></div>}
      </section>

      <section className="story" id="story"><p className="eyebrow"><span></span> Why Reloop</p><h2>Made for real life.<br/>Designed to feel <em>natural.</em></h2></section>
    </main>

    <div className={`overlay ${ordersOpen ? 'show' : ''}`} onClick={() => setOrdersOpen(false)} aria-hidden="true" />
    <aside className={`orders-drawer ${ordersOpen ? 'open' : ''}`} aria-label="My orders" aria-hidden={!ordersOpen}>
      <div className="drawer-header"><div><p>YOUR ORDERS</p><h2>Order history</h2></div><button onClick={() => setOrdersOpen(false)} aria-label="Close orders"><XMarkIcon className="icon"/></button></div>
      <div className="order-history-list">
        <form className="phone-lookup" onSubmit={lookupChallenge ? verifyPhoneOtp : requestPhoneOtp}>
          <label>Phone number<input type="tel" value={lookupPhone} onChange={event => setLookupPhone(event.target.value)} placeholder="01XXXXXXXXX" pattern="01[3-9][0-9]{8}" required disabled={Boolean(lookupChallenge)}/></label>
          {lookupChallenge && <label>6-digit OTP<input value={lookupOtp} onChange={event => setLookupOtp(event.target.value.replace(/[^0-9]/g,'').slice(0,6))} placeholder="000000" inputMode="numeric" pattern="[0-9]{6}" required/></label>}
          <button className="phone-lookup-button" disabled={lookupLoading}>{lookupLoading ? 'Please wait…' : lookupChallenge ? 'Verify & find orders' : 'Send phone OTP'}</button>
          {lookupChallenge && <button type="button" className="phone-lookup-reset" onClick={() => { setLookupChallenge(null); setLookupOtp(''); setLookupMessage('') }}>Use another number</button>}
          {lookupMessage && <p className="lookup-message">{lookupMessage}</p>}
        </form>
        {ordersLoading && <p className="order-history-empty">Loading your orders…</p>}
        {!ordersLoading && orderHistory.length === 0 && <div className="order-history-empty"><ShoppingBagIcon className="empty-icon"/><h3>No orders on this device</h3><p>Orders placed from this browser will appear here.</p></div>}
        {!ordersLoading && orderHistory.map(order => <button className="order-history-card" key={order.id} onClick={async () => { setOrdersOpen(false); if (order.trackingToken) return navigate(`/order-success/${order.id}`, { state: { id: order.id, orderNumber: order.orderNumber || order.order_number, trackingToken: order.trackingToken } }); const lookupToken = localStorage.getItem('poshak-guest-lookup-token'); const response = await fetch(`/api/orders/lookup/${order.id}`, { headers: { 'x-lookup-token': lookupToken || '' } }); if (response.ok) { const invoice = await response.json(); navigate(`/order-success/${order.id}`, { state: { order: invoice, id: order.id, orderNumber: invoice.orderNumber } }) } }}>
          <span><b>{order.orderNumber || order.order_number || `#${order.id}`}</b><small>{order.createdAt ? new Date(order.createdAt).toLocaleString('en-BD') : 'Recent order'}</small></span>
          <span><strong>{money(order.total || 0)}</strong><em>{order.status || 'pending'}</em></span>
        </button>)}
      </div>
    </aside>
    <div className={`overlay ${cartOpen ? 'show' : ''}`} onClick={() => setCartOpen(false)} aria-hidden="true" />
    <aside className={`cart-drawer ${cartOpen ? 'open' : ''}`} aria-label="Shopping cart" aria-hidden={!cartOpen}>
      <div className="drawer-header"><div><p>YOUR BAG</p><h2>{cartCount} {cartCount === 1 ? 'item' : 'items'}</h2></div><button onClick={() => setCartOpen(false)} aria-label="Close cart"><XMarkIcon className="icon"/></button></div>
      <div className="cart-items">{cart.length === 0 ? <div className="empty-cart"><ShoppingBagIcon className="empty-icon"/><h3>Your bag is empty</h3><p>Add something you’ll love.</p></div> : cart.map((item, index) => { const p = products.find(x => x.id === item.id); return p ? <div className="cart-item" key={`${item.id}-${item.size}`}><div className="cart-thumb">{p.image ? <img src={p.image} alt=""/> : p.name.charAt(0)}</div><div><p>{p.category}</p><h3>{p.name}</h3><strong>{money(p.price)}</strong><div className="quantity"><button onClick={() => changeQty(index, -1)} aria-label="Decrease quantity"><MinusIcon className="icon"/></button><span>{item.qty}</span><button onClick={() => changeQty(index, 1)} aria-label="Increase quantity"><PlusIcon className="icon"/></button></div></div></div> : null })}</div>
      {cart.length > 0 && <div className="drawer-footer"><div><span>Subtotal</span><strong>{money(subtotal)}</strong></div><p>Delivery calculated at checkout</p><button className="checkout-button" onClick={() => navigate('/checkout')}>Continue to checkout <ArrowRightIcon className="icon"/></button></div>}
    </aside>
  </>
}

function ProductDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [product, setProduct] = useState(null)
  const [products, setProducts] = useState([])
  const [size, setSize] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [cart, setCart] = useState(() => JSON.parse(localStorage.getItem('poshak-cart') || '[]'))

  useEffect(() => {
    fetch('/api/products').then(r => r.json()).then(data => {
      setProducts(data)
      const found = data.find(item => item.id === Number(id)) || null
      setProduct(found)
      setSize(found?.sizes?.split(',')[0] || '')
    })
  }, [id])

  const addToCart = () => {
    if (!product || !size) return
    const next = cart.map(item => ({ ...item }))
    const existingTotal = next.filter(item => item.id === product.id).reduce((sum, item) => sum + item.qty, 0)
    const allowed = Math.max(0, product.stock - existingTotal)
    const addQty = Math.min(quantity, allowed)
    if (addQty < 1) return
    const found = next.find(item => item.id === product.id && item.size === size)
    if (found) found.qty += addQty
    else next.push({ id: product.id, size, qty: addQty })
    setCart(next)
    localStorage.setItem('poshak-cart', JSON.stringify(next))
    navigate('/')
  }

  if (!product) return <main className="detail-page"><div className="detail-loading">Loading product…</div></main>
  const sizes = product.sizes?.split(',').map(value => value.trim()).filter(Boolean) || []
  const related = products.filter(item => item.category === product.category && item.id !== product.id).slice(0, 3)

  return <main className="detail-page">
    <header className="checkout-header"><Link className="logo" to="/" aria-label="Reloop home"><img className="brand-logo" src={reloopLogo} alt="Reloop"/></Link><Link className="back-link" to="/"><ArrowLeftIcon className="icon"/> Back to shop</Link></header>
    <motion.section className="detail-grid" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .45 }}>
      <div className="detail-image">{product.image ? <img src={product.image} alt={product.name}/> : <div className="detail-monogram">{product.name.charAt(0)}</div>}</div>
      <div className="detail-copy"><p className="eyebrow"><span></span> {product.category}</p><h1>{product.name}</h1><strong className="detail-price">{money(product.price)}</strong><p className="detail-description">Comfortable everyday wear, selected for a clean fit and lasting quality. Available for cash on delivery across Bangladesh.</p>
        <div className="size-section"><div><span>Size</span><b>{size}</b></div><div className="size-options">{sizes.map(value => <button key={value} className={size === value ? 'selected' : ''} onClick={() => setSize(value)}>{value}</button>)}</div></div>
        <div className="detail-actions"><div className="detail-quantity"><button onClick={() => setQuantity(value => Math.max(1, value - 1))} aria-label="Decrease quantity"><MinusIcon className="icon"/></button><span>{quantity}</span><button onClick={() => setQuantity(value => Math.min(product.stock, value + 1))} aria-label="Increase quantity"><PlusIcon className="icon"/></button></div><button className="add-detail" disabled={product.stock < 1} onClick={addToCart}>{product.stock > 0 ? 'Add to bag' : 'Sold out'}<ShoppingBagIcon className="icon"/></button></div>
        <p className="stock-message">{product.stock > 0 ? `${product.stock} pieces available` : 'Currently unavailable'}</p>
      </div>
    </motion.section>
    {related.length > 0 && <section className="related-section"><p className="eyebrow"><span></span> You may also like</p><div className="product-grid related-grid">{related.map(item => <article className="product-card" key={item.id}><Link className="product-image-link" to={`/product/${item.id}`}><div className="product-image">{item.image ? <img src={item.image} alt={item.name}/> : <div className="monogram">{item.name.charAt(0)}</div>}</div></Link><div className="product-info"><div><p>{item.category}</p><Link className="product-title-link" to={`/product/${item.id}`}><h3>{item.name}</h3></Link><strong className="product-price">{money(item.price)}</strong></div></div></article>)}</div></section>}
  </main>
}

function OrderSuccess() {
  const navigate = useNavigate()
  const { id } = useParams()
  const state = window.history.state?.usr || {}
  const [invoice, setInvoice] = useState(state.order || null)
  const [loadError, setLoadError] = useState('')
  const [cancelMessage, setCancelMessage] = useState('')
  const trackingToken = state.trackingToken || sessionStorage.getItem(`poshak-order-token-${id}`) || localStorage.getItem(`poshak-order-token-${id}`) || ''

  useEffect(() => {
    if (state.order) return
    if (!trackingToken) {
      setLoadError('Tracking details are unavailable. Use the secure link from checkout.')
      return
    }
    const loadInvoice = () => fetch(`/api/orders/${id}/track?token=${encodeURIComponent(trackingToken)}`)
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load invoice'); return data })
      .then(setInvoice)
      .catch(error => setLoadError(error.message))
    loadInvoice()
    const timer = window.setInterval(loadInvoice, 15000)
    return () => window.clearInterval(timer)
  }, [id, trackingToken])

  const cancelOrder = async () => {
    if (!trackingToken || !window.confirm('Cancel this order and restore its stock?')) return
    try {
      const response = await fetch(`/api/orders/${id}/cancel`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ token:trackingToken,reason:'Customer cancelled from invoice' }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not cancel order')
      setCancelMessage('Order cancelled successfully.')
      setInvoice(current => current ? { ...current,status:'cancelled',history:[...(current.history || []),{status:'cancelled',reason:'Customer cancellation',createdAt:new Date().toISOString()}]} : current)
    } catch(error) { setCancelMessage(error.message) }
  }

  const status = invoice?.status || 'pending'
  const statusLabel = status === 'new' ? 'Order placed' : status.charAt(0).toUpperCase() + status.slice(1)

  return <main className="success-page"><motion.div className="success-card invoice-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
    <div className="success-check">✓</div><p className="eyebrow"><span></span> Order confirmed</p>
    <h1>Thank you{invoice?.customer?.name ? `, ${invoice.customer.name}` : state.name ? `, ${state.name}` : ''}.</h1>
    <div className="invoice-status"><span>Current status</span><strong className={`status-${status}`}>{statusLabel}</strong></div>
    <section className="invoice-meta"><div><span>Invoice</span><b>{invoice?.orderNumber || state.orderNumber || `#${state.id || id}`}</b></div><div><span>Payment</span><b>{invoice?.payment?.method === 'cash_on_delivery' ? 'Cash on delivery' : 'Cash on delivery'}</b></div><div><span>Date</span><b>{invoice?.createdAt ? new Date(invoice.createdAt).toLocaleDateString('en-BD') : 'Just now'}</b></div></section>
    {invoice?.customer && <section className="invoice-address"><span>Deliver to</span><b>{invoice.customer.name}</b><p>{invoice.customer.phone}<br/>{invoice.customer.address}<br/>{invoice.customer.district}</p></section>}
    {loadError && <p className="invoice-error">{loadError}</p>}
    {invoice?.items?.length > 0 && <section className="invoice-items"><div className="invoice-items-head"><span>Item</span><span>Qty</span><span>Total</span></div>{invoice.items.map((item,index)=><div className="invoice-item" key={`${item.name}-${index}`}><span><b>{item.name}</b><small>{item.variant ? `Size ${item.variant}` : ''}{item.sku ? ` · ${item.sku}` : ''}</small></span><span>{item.quantity}</span><strong>{money(item.lineTotal || item.unitPrice * item.quantity)}</strong></div>)}</section>}
    <section className="invoice-totals"><div><span>Subtotal</span><b>{money(invoice?.subtotal ?? state.total ?? 0)}</b></div><div><span>Delivery</span><b>{money(invoice?.delivery ?? 0)}</b></div><div className="invoice-grand-total"><span>Total</span><strong>{money(invoice?.total ?? state.total ?? 0)}</strong></div></section>
    {invoice?.history?.length > 0 && <section className="invoice-history"><span>Order updates</span>{invoice.history.map((entry,index)=><div key={`${entry.status}-${index}`}><b>{entry.status.charAt(0).toUpperCase()+entry.status.slice(1)}</b><small>{new Date(entry.createdAt).toLocaleString('en-BD')}</small></div>)}</section>}
    <p className="success-note">We’ll call you to confirm delivery details.</p>
    {cancelMessage && <p className={cancelMessage.includes('successfully') ? 'success-note' : 'invoice-error'}>{cancelMessage}</p>}
    <div className="invoice-actions"><button className="print-invoice" onClick={() => window.print()}>Print invoice</button>{['pending','confirmed'].includes(status) && trackingToken && <button className="cancel-order" onClick={cancelOrder}>Cancel order</button>}<button className="place-order" onClick={() => navigate('/')}>Continue shopping <ArrowRightIcon className="icon"/></button></div>
  </motion.div></main>
}

function Checkout() {
  const navigate = useNavigate()
  const [products, setProducts] = useState([])
  const [cart, setCart] = useState(() => JSON.parse(localStorage.getItem('poshak-cart') || '[]'))
  const [district, setDistrict] = useState('Dhaka')
  const [status, setStatus] = useState({ type: '', message: '' })
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => { fetch('/api/products').then(r => r.json()).then(setProducts) }, [])
  useEffect(() => { if (cart.length === 0 && status.type !== 'success') navigate('/') }, [cart.length, navigate, status.type])

  const subtotal = cart.reduce((sum, item) => sum + (products.find(p => p.id === item.id)?.price || 0) * item.qty, 0)
  const delivery = district === 'Dhaka' ? 60 : 120

  const placeOrder = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setStatus({ type: '', message: '' })
    const fields = Object.fromEntries(new FormData(event.currentTarget))
    try {
      const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...fields, items: cart }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not place your order')
      localStorage.removeItem('poshak-cart')
      sessionStorage.setItem(`poshak-order-token-${result.id}`, result.trackingToken)
      localStorage.setItem(`poshak-order-token-${result.id}`, result.trackingToken)
      const history = readOrderHistory().filter(entry => entry.id !== result.id)
      history.unshift({ id: result.id, orderNumber: result.orderNumber, trackingToken: result.trackingToken, createdAt: new Date().toISOString(), customerName: fields.name, customerPhone: fields.phone })
      localStorage.setItem('poshak-order-history', JSON.stringify(history.slice(0, 30)))
      navigate(`/order-success/${result.id}`, { state: { id: result.id, orderNumber: result.orderNumber, trackingToken: result.trackingToken, name: fields.name, total: subtotal + delivery }, replace: true })
    } catch (error) {
      setStatus({ type: 'error', message: error.message })
    } finally { setSubmitting(false) }
  }

  return <main className="checkout-page"><header className="checkout-header"><Link className="logo" to="/" aria-label="Reloop home"><img className="brand-logo" src={reloopLogo} alt="Reloop"/></Link><button onClick={() => navigate(-1)}><ArrowLeftIcon className="icon"/> Back to shop</button></header>
    <div className="checkout-grid"><section><p className="eyebrow"><span></span> Secure checkout</p><h1>Delivery details</h1>
      {status.message && <div className={`checkout-status ${status.type}`} role="status">{status.message}</div>}
      {status.type !== 'success' && <form className="checkout-form" onSubmit={placeOrder}><label>Full name<input name="name" required autoComplete="name" placeholder="Your full name"/></label><label>Phone number<input name="phone" required pattern="01[3-9][0-9]{8}" autoComplete="tel" placeholder="01XXXXXXXXX"/></label><label>Full address<textarea name="address" required autoComplete="street-address" rows="3" placeholder="House, road, area and landmark"/></label><label>Delivery area<select name="district" value={district} onChange={e => setDistrict(e.target.value)}><option value="Dhaka">Inside Dhaka</option><option value="Other">Outside Dhaka</option></select></label><button className="place-order" disabled={submitting || cart.length === 0}>{submitting ? 'Placing order…' : `Place order · ${money(subtotal + delivery)}`}<ArrowRightIcon className="icon"/></button><p className="payment-note">Cash on delivery · No card details required</p></form>}
      {status.type === 'success' && <button className="place-order" onClick={() => navigate('/')}>Continue shopping <ArrowRightIcon className="icon"/></button>}
    </section><aside className="order-summary"><p>ORDER SUMMARY</p>{cart.map((item, index) => { const product = products.find(p => p.id === item.id); return product ? <div className="summary-item" key={`${item.id}-${index}`}><div>{product.image ? <img src={product.image} alt=""/> : product.name.charAt(0)}</div><span><b>{product.name}</b><small>Size {item.size} · Qty {item.qty}</small></span><strong>{money(product.price * item.qty)}</strong></div> : null })}<div className="summary-totals"><div><span>Subtotal</span><b>{money(subtotal)}</b></div><div><span>Delivery</span><b>{money(delivery)}</b></div><div className="grand-total"><span>Total</span><strong>{money(subtotal + delivery)}</strong></div></div></aside></div>
  </main>
}

export default function AppNew() {
  const [siteReady, setSiteReady] = useState(false)
  const [loaderLeaving, setLoaderLeaving] = useState(false)

  useEffect(() => {
    const startedAt = Date.now()
    const minimumTime = new Promise(resolve => window.setTimeout(resolve, 1800))
    const readinessTimeout = new Promise(resolve => window.setTimeout(resolve, 5000))
    const loadedAssets = Promise.all([
      document.fonts?.ready || Promise.resolve(),
      fetch('/api/products').then(response => response.ok ? response.json() : null).catch(() => null),
      Promise.all([
        reloopLogo,
        reloopBrandKit,
      ].map(source => new Promise(resolve => {
        const image = new Image()
        image.onload = resolve
        image.onerror = resolve
        image.src = source
      }))),
    ]).catch(() => null)

    Promise.all([Promise.race([loadedAssets, readinessTimeout]), minimumTime]).then(() => {
      const elapsed = Date.now() - startedAt
      window.setTimeout(() => setLoaderLeaving(true), Math.max(0, 100 - elapsed))
      window.setTimeout(() => setSiteReady(true), 700)
    })
  }, [])

  return <>
    {!siteReady && <div className={`brand-loader ${loaderLeaving ? 'leaving' : ''}`} role="status" aria-label="Loading Reloop">
      <span className="loader-line loader-line-left" />
      <span className="loader-line loader-line-right" />
      <div className="loader-brand"><img src={reloopBrandKit} alt="Reloop"/></div>
    </div>}
    <BrowserRouter><Routes><Route path="/" element={<Storefront/>}/><Route path="/product/:id" element={<ProductDetail/>}/><Route path="/checkout" element={<Checkout/>}/><Route path="/order-success/:id" element={<OrderSuccess/>}/><Route path="*" element={<Storefront/>}/></Routes></BrowserRouter>
  </>
}
