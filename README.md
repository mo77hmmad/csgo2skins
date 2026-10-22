# Skin Market

Peer-to-peer CS2 skin marketplace: Steam login, SQLite database, card top-ups (Stripe), Steam trade-offer deposit/withdraw.

## Run
    npm install
    cp .env.example .env     # fill in the keys
    npm start                # http://localhost:3000

## Setup
1. **Steam API key**: https://steamcommunity.com/dev/apikey (domain = your BASE_URL host).
2. **Stripe**: add the secret key; create a webhook to `BASE_URL/stripe/webhook` for `checkout.session.completed`
   (local testing: `stripe listen --forward-to localhost:3000/stripe/webhook`).
3. **Steam bot**: a separate Steam account with Steam Guard mobile authenticator; put its credentials plus
   shared_secret / identity_secret in `.env`. The bot holds items in escrow (deposit -> sell -> withdraw).
   Without a bot, trades are only recorded in the `trades` table.

## Flow
Login -> save trade URL -> deposit skin (bot sends you an offer, accept) -> list at a price -> buyer pays from wallet balance
-> ownership changes in the DB (seller gets price minus FEE_PERCENT) -> buyer withdraws (bot sends the skin).

## Before going live
- Run behind HTTPS; set BASE_URL to https URL and a strong SESSION_SECRET.
- Seller payouts (balance -> real money) are not implemented; add Stripe Connect or similar, plus KYC.
- Check the payments/marketplace rules in your country and Valve's/Steam's terms (the bot account can be restricted).
- Add admin tools, logging, and backups; the DB is a single SQLite file (`data.db`).

## GitHub
    git init && git add . && git commit -m "Initial commit"
    git branch -M main
    git remote add origin https://github.com/<you>/skin-market.git
    git push -u origin main
`.env`, `data.db` and `sessions/` are in `.gitignore`; never commit your keys. Add them as repository Secrets if you deploy with Actions.
