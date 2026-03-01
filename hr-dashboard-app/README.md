# HR Dashboard (standalone)

Standalone HR dashboard app extracted from the main Samushao project. It uses the **same database** (and same Pinecone index) as the main app, so you can run it in a separate repo/folder and point it at the existing DB.

## Setup

1. **Copy this folder** to wherever you want the separate project (e.g. another repo).

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment**
   - Copy `.env.example` to `.env`
   - Fill in the same values you use in the main Samushao app:
     - `DATABASE_URL` (or `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`) – same Postgres as main app
     - `SESSION_SECRET` (can be same as main app if you want shared sessions, or a new one)
     - `PINECONE_API_KEY`, `PINECONE_INDEX`, `JINA_API_KEY`, `GEMINI_API_KEY` or `GEMINI_CV_READER_API_KEY`
     - `PROPOSITIONAL_MAIL_USER`, `PROPOSITIONAL_MAIL_PASS` for credits purchase emails
   - Optional: `HR_SKIP_AUTH=1` for local dev without login; `HR_DEV_ACCOUNT_ID=1` to tie “request resume” to a specific HR account when skip-auth is on.

4. **Build CSS (first time or after changing Tailwind)**
   ```bash
   npm run build:css
   ```

## Run

- **Dev** (nodemon + Tailwind watch + browser-sync):
  ```bash
  npm run dev
  ```
  App: http://localhost:4000  
  Browser-sync: http://localhost:4001

- **Production**
  ```bash
  npm run build:css
  npm start
  ```

## What’s included

- All HR dashboard routes: auth, dashboard, search (Pinecone + Gemini), candidates, credits, credits-return, logout.
- Same DB tables: `hr_accounts`, `hr_credits_history`, `hr_requested_resumes`, plus `users`, `resumes`, `visitors`, `user_without_cv` for candidate data.
- Same Pinecone index and Jina/Gemini usage for candidate search and assessment.
- Sessions stored in Postgres (same `session` table if you use the same DB and `SESSION_SECRET`).

You can run this app on another host/domain (e.g. `hr.samushao.ge`) and keep the main app elsewhere; both connect to the same database and Pinecone.
