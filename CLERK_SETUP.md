# Clerk Authentication Setup

## 1. Create a Clerk account
Go to https://clerk.com and create an application called "The Bearing".

## 2. Configure sign-in methods
In Clerk Dashboard → User & Authentication → Email, Phone, Username:
- ✅ Email address (magic link)
- ✅ Google OAuth
- ✅ Apple OAuth

## 3. Get your keys
- Publishable key: `pk_live_...` (safe for frontend)
- Secret key: `sk_live_...` (backend only — never in HTML)

## 4. Replace placeholder in HTML files
Search for `YOUR_CLERK_PUBLISHABLE_KEY` in these files and replace with your publishable key:
- `admin-login.html`
- `my-account.html`

## 5. Set up the webhook (auto-creates members in KV)
In Clerk Dashboard → Webhooks → Add Endpoint:
- URL: `https://thebearing.io/api/clerk-webhook`
- Events: `user.created`, `user.updated`, `user.deleted`
- Copy the **Signing Secret** (starts with `whsec_`)

Then run:
```
wrangler secret put CLERK_WEBHOOK_SECRET
# Paste the whsec_... value when prompted
```

## 6. Deploy
Push to GitHub → Cloudflare deploys automatically.

## 7. Test
1. Go to thebearing.io/my-account.html
2. Sign up with Google or magic link
3. Check thebearing.io/admin-guests.html → member should appear automatically

## Admin access restriction (optional)
To restrict admin pages to specific email addresses only, add this to your Clerk Dashboard → Restrictions:
- Allowlist: `*@thebearing.io` (or specific emails)
- Block sign-ups on admin-login.html (it already hides the sign-up link)
