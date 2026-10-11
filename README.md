# Promotional Content Hub

An internal web app for promotional content teams: Ingest Tracker (with approval), Workload Tracker, PSD Daily Plug List, Knowledge Base, Dashboard and an Admin area.

Built with Node.js (Express), PostgreSQL and React (Vite).

## Getting started

Requirements: Node.js 20 or newer and PostgreSQL 14 or newer.

```bash
cp .env.example .env     # fill in the values described inside the file
npm install
npm run build            # builds the front end
npm start
```

For front-end development, run `npm start` and `npm run dev:client` in two terminals.

## Notes

- All settings are read from `.env`; `.env.example` lists them with comments. Never commit your real `.env`.
- Deployment, security and operations notes are kept with the team's internal documentation, not in this repository.

## Tests

```bash
npm test
```
