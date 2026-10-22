const $ = s => document.querySelector(s);
const usd = c => '$' + (c / 100).toFixed(2);
const img = i => `https://community.cloudflare.steamstatic.com/economy/image/${i}/128fx128f`;
let me = null;
const say = t => $('#msg').textContent = t || '';
async function api(path, body) {
  const r = await fetch('/api' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Error'); return j;
}
const act = fn => async (...a) => { try { say(''); const r = await fn(...a); if (r && r.message) say(r.message + ' Code: ' + r.code); await refresh(); } catch (e) { say(e.message); } };
function card(it, btns) {
  const d = document.createElement('div'); d.className = 'card';
  const im = document.createElement('img'); im.src = img(it.icon); d.append(im);
  const n = document.createElement('div'); n.textContent = it.name; d.append(n);
  if (it.price) { const p = document.createElement('div'); p.className = 'p'; p.textContent = usd(it.price); d.append(p); }
  if (it.seller) { const s = document.createElement('small'); s.textContent = 'by ' + it.seller; d.append(s); }
  if (it.status) { const s = document.createElement('small'); s.textContent = it.status; d.append(s); d.append(document.createElement('br')); }
  (btns || []).forEach(([t, f, alt]) => { const b = document.createElement('button'); b.textContent = t; if (alt) b.className = 'alt'; b.onclick = act(f); d.append(b); });
  return d;
}
async function refresh() {
  me = (await api('/me')).user;
  const a = $('#auth'); a.textContent = '';
  if (me) {
    const i = document.createElement('img'); i.src = me.avatar; const n = document.createElement('span'); n.textContent = me.name + ' · ' + usd(me.balance);
    const o = document.createElement('button'); o.className = 'alt'; o.textContent = 'Logout'; o.onclick = async () => { await api('/auth/logout'.replace('/auth', '/../auth'), {}).catch(() => {}); await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); location.reload(); };
    a.append(i, n, o); $('#bal').textContent = usd(me.balance); $('#tradeUrl').value = me.trade_url || '';
  } else { const l = document.createElement('a'); l.href = '/auth/steam'; l.textContent = 'Sign in through Steam'; l.style.color = '#6fb1ff'; a.append(l); }
  const m = await api('/market'); const g = $('#marketGrid'); g.textContent = '';
  m.forEach(it => g.append(card(it, me ? [['Buy', () => api('/buy', { itemId: it.id })]] : [])));
  const mg = $('#mineGrid'); mg.textContent = '';
  if (me) (await api('/my-items')).forEach(it => {
    const b = [];
    if (it.status === 'in_stock') { b.push(['List', () => { const p = prompt('Price in USD'); if (p) return api('/list', { itemId: it.id, price: Math.round(parseFloat(p) * 100) }); }]); b.push(['Withdraw', () => api('/withdraw', { itemId: it.id }), 1]); }
    if (it.status === 'listed') b.push(['Unlist', () => api('/unlist', { itemId: it.id }), 1]);
    mg.append(card(it, b));
  });
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('main section').forEach(s => s.hidden = s.id !== b.dataset.tab);
});
$('#saveUrl').onclick = act(() => api('/tradeurl', { url: $('#tradeUrl').value }));
$('#topup').onclick = act(async () => { const r = await api('/topup', { amount: Number($('#amount').value) }); location = r.url; });
$('#loadInv').onclick = act(async () => {
  const g = $('#invGrid'); g.textContent = '';
  (await api('/inventory')).forEach(it => g.append(card(it, [['Deposit', () => api('/deposit', { assetid: it.assetid })]])));
});
refresh().catch(e => say(e.message));
