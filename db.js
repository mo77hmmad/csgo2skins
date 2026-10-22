const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || './data.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  steamid TEXT PRIMARY KEY, name TEXT, avatar TEXT, trade_url TEXT,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  created_at INTEGER DEFAULT (strftime('%s','now')));
-- status: pending_deposit | in_stock | listed | pending_withdraw | withdrawn | failed
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, assetid TEXT, owner TEXT NOT NULL,
  name TEXT, icon TEXT, status TEXT NOT NULL, price INTEGER,
  FOREIGN KEY(owner) REFERENCES users(steamid));
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, buyer TEXT, seller TEXT, item_id INTEGER,
  price INTEGER, fee INTEGER, created_at INTEGER DEFAULT (strftime('%s','now')));
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT UNIQUE, steamid TEXT,
  amount INTEGER, status TEXT, created_at INTEGER DEFAULT (strftime('%s','now')));
CREATE TABLE IF NOT EXISTS trades(
  id INTEGER PRIMARY KEY AUTOINCREMENT, offer_id TEXT, type TEXT, steamid TEXT,
  item_id INTEGER, status TEXT, code TEXT);
`);
module.exports = db;
