// npm run dev: loads .env here instead of `node --env-file`. With --env-file, `node --watch` also watches the
// project folder (on Windows), so every upload, backup or package install restarted the server mid-request.
// Restart after editing .env. The import must stay dynamic: index.mjs reads the settings as it loads.
process.loadEnvFile('.env');
await import('./index.mjs');
