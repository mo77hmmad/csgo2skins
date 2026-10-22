// Fetches a user's public CS2 inventory (appid 730, context 2).
async function getInventory(steamid) {
  const url = `https://steamcommunity.com/inventory/${steamid}/730/2?l=english&count=1000`;
  const res = await fetch(url, { headers: { 'User-Agent': 'skin-market/1.0' } });
  if (res.status === 403) throw new Error('Inventory is private. Set it to public in Steam privacy settings.');
  if (!res.ok) throw new Error('Steam inventory unavailable (' + res.status + ')');
  const data = await res.json();
  const desc = new Map((data.descriptions || []).map(d => [d.classid + '_' + d.instanceid, d]));
  return (data.assets || []).map(a => {
    const d = desc.get(a.classid + '_' + a.instanceid);
    return d && d.tradable ? { assetid: a.assetid, name: d.market_hash_name, icon: d.icon_url } : null;
  }).filter(Boolean);
}
module.exports = { getInventory };
