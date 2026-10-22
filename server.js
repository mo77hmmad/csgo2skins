require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const Stripe = require('stripe');
const db = require('./db');
const bot = require('./bot');
const { getInventory } = require('./steam');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const FEE = Number(process.env.FEE_PERCENT || 5);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], imgSrc: ["'self'", 'https://community.cloudflare.steamstatic.com', 'https://avatars.steamstatic.com', 'https://avatars.akamai.steamstatic.com', 'data:'],
  scriptSrc: ["'self'"], styleSrc: ["'self'"], connectSrc: ["'self'"] } } }));

// Stripe webhook needs the raw body, so it is registered before express.json()
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return res.status(400).send('bad signature'); }
  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    const s = event.data.object;
    db.transaction(() => {
      const p = db.prepare("SELECT * FROM payments WHERE session_id=? AND status='pending'").get(s.id);
      if (!p) return; // unknown or already credited -> idempotent
      db.prepare("UPDATE payments SET status='paid' WHERE id=?").run(p.id);
      db.prepare('UPDATE users SET balance=balance+? WHERE steamid=?').run(p.amount, p.steamid);
    })();
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(session({
  store: new FileStore({ path: './sessions', logFn() {} }),
  secret: process.env.SESSION_SECRET || 'dev-secret', resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: BASE.startsWith('https'), maxAge: 7 * 864e5 }
}));
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((u, d) => d(null, u.steamid));
passport.deserializeUser((id, d) => d(null, db.prepare('SELECT * FROM users WHERE steamid=?').get(id) || false));
passport.use(new SteamStrategy({ returnURL: BASE + '/auth/steam/return', realm: BASE + '/', apiKey: process.env.STEAM_API_KEY },
  (identifier, profile, done) => {
    const p = { steamid: profile.id, name: profile.displayName, avatar: (profile.photos[2] || profile.photos[0] || {}).value };
    db.prepare(`INSERT INTO users(steamid,name,avatar) VALUES(@steamid,@name,@avatar)
      ON CONFLICT(steamid) DO UPDATE SET name=@name, avatar=@avatar`).run(p);
    done(null, db.prepare('SELECT * FROM users WHERE steamid=?').get(p.steamid));
  }));

app.get('/auth/steam', passport.authenticate('steam'));
app.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.post('/auth/logout', (req, res) => req.logout(() => res.json({ ok: true })));

// --- API ---
const api = express.Router();
api.use(rateLimit({ windowMs: 60000, max: 120 }));
api.use((req, res, next) => { // CSRF guard: state-changing calls must be JSON (cannot be sent cross-site by plain forms)
  if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
  next();
});
const auth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Sign in with Steam first' });
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(400).json({ error: e.message }));
const pub = u => u && { steamid: u.steamid, name: u.name, avatar: u.avatar, trade_url: u.trade_url, balance: u.balance };

api.get('/me', (req, res) => res.json({ user: pub(req.user) || null }));

api.post('/tradeurl', auth, (req, res) => {
  const url = String(req.body.url || '');
  if (!/^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[\w-]+$/.test(url))
    return res.status(400).json({ error: 'Invalid trade URL' });
  db.prepare('UPDATE users SET trade_url=? WHERE steamid=?').run(url, req.user.steamid);
  res.json({ ok: true });
});

api.get('/inventory', auth, wrap(async (req, res) => {
  const used = new Set(db.prepare("SELECT assetid FROM items WHERE owner=? AND status='pending_deposit'").all(req.user.steamid).map(r => r.assetid));
  res.json((await getInventory(req.user.steamid)).filter(i => !used.has(i.assetid)));
}));

api.post('/deposit', auth, wrap(async (req, res) => {
  if (!req.user.trade_url) throw new Error('Set your trade URL first');
  const { assetid } = req.body;
  const real = (await getInventory(req.user.steamid)).find(i => i.assetid === String(assetid));
  if (!real) throw new Error('Item not found / not tradable'); // never trust client-supplied name/icon
  const dup = db.prepare("SELECT 1 FROM items WHERE assetid=? AND status='pending_deposit'").get(real.assetid);
  if (dup) throw new Error('Deposit already in progress');
  const id = db.prepare("INSERT INTO items(assetid,owner,name,icon,status) VALUES(?,?,?,?,'pending_deposit')")
    .run(real.assetid, req.user.steamid, real.name, real.icon).lastInsertRowid;
  try {
    const code = await bot.deposit(req.user, { id, assetid: real.assetid });
    res.json({ ok: true, code, message: 'Trade offer sent to you on Steam. Accept it to finish the deposit.' });
  } catch (e) { db.prepare("UPDATE items SET status='failed' WHERE id=?").run(id); throw e; }
}));

api.get('/my-items', auth, (req, res) =>
  res.json(db.prepare("SELECT id,name,icon,status,price FROM items WHERE owner=? AND status NOT IN ('failed','withdrawn') ORDER BY id DESC").all(req.user.steamid)));

api.post('/list', auth, (req, res) => {
  const price = Math.round(Number(req.body.price));
  if (!Number.isInteger(price) || price < 10 || price > 5000000) return res.status(400).json({ error: 'Price (cents) must be 10 - 5,000,000' });
  const r = db.prepare("UPDATE items SET status='listed', price=? WHERE id=? AND owner=? AND status IN ('in_stock','listed')").run(price, req.body.itemId, req.user.steamid);
  r.changes ? res.json({ ok: true }) : res.status(400).json({ error: 'Item not available' });
});

api.post('/unlist', auth, (req, res) => {
  const r = db.prepare("UPDATE items SET status='in_stock', price=NULL WHERE id=? AND owner=? AND status='listed'").run(req.body.itemId, req.user.steamid);
  r.changes ? res.json({ ok: true }) : res.status(400).json({ error: 'Item not listed' });
});

api.get('/market', (req, res) =>
  res.json(db.prepare("SELECT i.id,i.name,i.icon,i.price,u.name AS seller FROM items i JOIN users u ON u.steamid=i.owner WHERE i.status='listed' ORDER BY i.id DESC LIMIT 200").all()));

const buy = db.transaction((buyer, itemId) => {
  const it = db.prepare("SELECT * FROM items WHERE id=? AND status='listed'").get(itemId);
  if (!it) throw new Error('Item no longer available');
  if (it.owner === buyer) throw new Error('You cannot buy your own item');
  const fee = Math.round(it.price * FEE / 100);
  const d = db.prepare('UPDATE users SET balance=balance-? WHERE steamid=? AND balance>=?').run(it.price, buyer, it.price);
  if (!d.changes) throw new Error('Insufficient balance');
  db.prepare('UPDATE users SET balance=balance+? WHERE steamid=?').run(it.price - fee, it.owner);
  db.prepare("UPDATE items SET owner=?, status='in_stock', price=NULL WHERE id=?").run(buyer, it.id);
  db.prepare('INSERT INTO orders(buyer,seller,item_id,price,fee) VALUES(?,?,?,?,?)').run(buyer, it.owner, it.id, it.price, fee);
});
api.post('/buy', auth, wrap((req, res) => { buy(req.user.steamid, req.body.itemId); res.json({ ok: true }); }));

api.post('/withdraw', auth, wrap(async (req, res) => {
  if (!req.user.trade_url) throw new Error('Set your trade URL first');
  const claim = db.prepare("UPDATE items SET status='pending_withdraw' WHERE id=? AND owner=? AND status='in_stock'").run(req.body.itemId, req.user.steamid);
  if (!claim.changes) throw new Error('Item not available');
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(req.body.itemId);
  try {
    const code = await bot.withdraw(req.user, item);
    res.json({ ok: true, code, message: 'Trade offer sent on Steam. Accept it to receive the skin.' });
  } catch (e) { db.prepare("UPDATE items SET status='in_stock' WHERE id=?").run(item.id); throw e; }
}));

api.post('/topup', auth, wrap(async (req, res) => {
  if (!stripe) throw new Error('Payments not configured');
  const usd = Number(req.body.amount);
  if (!(usd >= 5 && usd <= 500)) throw new Error('Amount must be between $5 and $500');
  const cents = Math.round(usd * 100);
  const s = await stripe.checkout.sessions.create({
    mode: 'payment', payment_method_types: ['card'], // Visa / Mastercard
    line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Wallet top-up' }, unit_amount: cents }, quantity: 1 }],
    success_url: BASE + '/?paid=1', cancel_url: BASE + '/?paid=0'
  });
  db.prepare("INSERT INTO payments(session_id,steamid,amount,status) VALUES(?,?,?,'pending')").run(s.id, req.user.steamid, cents);
  res.json({ url: s.url });
}));

app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public')));
bot.start();
app.listen(process.env.PORT || 3000, () => console.log('Skin Market on ' + BASE));
