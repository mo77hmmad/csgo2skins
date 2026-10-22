const crypto = require('crypto');
const db = require('./db');
const enabled = !!process.env.BOT_USERNAME;
let manager, community;

function start() {
  if (!enabled) return console.warn('[bot] disabled (BOT_USERNAME empty) - trades are only recorded as pending.');
  const SteamUser = require('steam-user');
  const SteamCommunity = require('steamcommunity');
  const TradeOfferManager = require('steam-tradeoffer-manager');
  const SteamTotp = require('steam-totp');
  const client = new SteamUser();
  community = new SteamCommunity();
  manager = new TradeOfferManager({ steam: client, community, language: 'en', pollInterval: 10000, cancelTime: 10 * 60 * 1000 });
  client.logOn({
    accountName: process.env.BOT_USERNAME, password: process.env.BOT_PASSWORD,
    twoFactorCode: SteamTotp.generateAuthCode(process.env.BOT_SHARED_SECRET)
  });
  client.on('loggedOn', () => console.log('[bot] logged in'));
  client.on('webSession', (sid, cookies) => {
    manager.setCookies(cookies, err => err && console.error('[bot] cookies', err));
    community.setCookies(cookies);
    community.startConfirmationChecker(10000, process.env.BOT_IDENTITY_SECRET);
  });
  manager.on('sentOfferChanged', (offer) => onOffer(offer, TradeOfferManager.ETradeOfferState));
}

function record(type, user, item, offerId, code) {
  db.prepare('INSERT INTO trades(offer_id,type,steamid,item_id,status,code) VALUES(?,?,?,?,?,?)')
    .run(String(offerId || ''), type, user.steamid, item.id, 'sent', code);
}

function send(type, user, item, build) {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  if (!enabled) { record(type, user, item, '', code); return Promise.resolve(code); }
  return new Promise((resolve, reject) => {
    const offer = manager.createOffer(user.trade_url);
    build(offer);
    offer.setMessage(`Skin Market ${type} - code ${code}`);
    offer.send(err => {
      if (err) return reject(err);
      record(type, user, item, offer.id, code);
      resolve(code);
    });
  });
}

const ref = a => ({ appid: 730, contextid: '2', assetid: a });
const deposit = (user, item) => send('deposit', user, item, o => o.addTheirItem(ref(item.assetid)));

function withdraw(user, item) {
  if (!enabled) return send('withdraw', user, item, () => {});
  return send('withdraw', user, item, () => {}).catch(e => { throw e; });
}

// Withdraw needs the bot's own copy; look it up in the bot inventory first.
async function withdrawReal(user, item) {
  if (!enabled) return send('withdraw', user, item, () => {});
  const inv = await new Promise((res, rej) =>
    manager.getInventoryContents(730, 2, true, (e, i) => e ? rej(e) : res(i)));
  const mine = inv.find(i => String(i.assetid) === String(item.assetid));
  if (!mine) throw new Error('Item not found in bot inventory');
  return send('withdraw', user, item, o => o.addMyItem(ref(mine.assetid)));
}

function onOffer(offer, S) {
  const t = db.prepare('SELECT * FROM trades WHERE offer_id=?').get(String(offer.id));
  if (!t) return;
  const ok = offer.state === S.Accepted;
  const dead = [S.Declined, S.Canceled, S.Expired, S.InvalidItems, S.CanceledBySecondFactor].includes(offer.state);
  if (!ok && !dead) return;
  db.prepare('UPDATE trades SET status=? WHERE id=?').run(ok ? 'accepted' : 'failed', t.id);
  if (t.type === 'deposit') {
    if (ok) offer.getReceivedItems(false, (err, items) => {
      if (err || !items[0]) return console.error('[bot] received items', err);
      db.prepare("UPDATE items SET assetid=?, status='in_stock' WHERE id=?").run(String(items[0].assetid), t.item_id);
    });
    else db.prepare("UPDATE items SET status='failed' WHERE id=?").run(t.item_id);
  } else {
    db.prepare('UPDATE items SET status=? WHERE id=?').run(ok ? 'withdrawn' : 'in_stock', t.item_id);
  }
}

module.exports = { start, deposit, withdraw: withdrawReal };
