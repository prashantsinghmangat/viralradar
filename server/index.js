const os = require('os');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const { openDb, getSetting } = require('./db');
const events = require('./events');
const { createWatcher } = require('./watcher');
const { scheduleRadar } = require('./jobs/radar');
const { istDay } = require('./sources/youtube');

// LAN IPv4 addresses, Wi-Fi/Ethernet first, virtual adapters (WSL, Docker, VirtualBox) last.
function lanUrls(port) {
  const virtual = /vEthernet|VirtualBox|VMware|docker|WSL|Hyper-V|Loopback|vbox|utun|br-/i;
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) list.push({ name, url: `http://${a.address}:${port}`, virtual: virtual.test(name) });
    }
  }
  const privateLan = (u) => /\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u);
  list.sort((a, b) => a.virtual - b.virtual || privateLan(b.url) - privateLan(a.url));
  return list.map((x) => x.url);
}

function createApp(db, { watcher, urls = [] }) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.text({ type: ['text/*'], limit: '50mb' }));

  app.get('/api/events', events.subscribe);
  app.use('/api', require('./routes/import')(db));
  app.use('/api', require('./routes/content')(db));
  app.use('/api', require('./routes/results')(db, { today: () => istDay() }));
  app.use('/api', require('./routes/radar')(db));
  app.use('/api', require('./routes/settings')(db, { watcher, lanUrls: urls }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Bad JSON bodies and other errors come back as JSON, not an HTML stack trace.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    const message = err.type === 'entity.parse.failed'
      ? `This is not valid JSON (${err.message}).`
      : err.type === 'entity.too.large' ? 'That file is too large (limit 50 MB).' : err.message;
    res.status(status).json({ ok: false, error: message });
  });
  return app;
}

async function main() {
  const db = openDb(config.DB_PATH);
  const watcher = createWatcher(db);
  const urls = lanUrls(config.PORT);
  const app = createApp(db, { watcher, urls });

  app.listen(config.PORT, config.HOST, async () => {
    console.log('\n  ViralRadar is running');
    console.log(`  Laptop:  http://localhost:${config.PORT}`);
    for (const u of urls) console.log(`  Network: ${u}`);
    if (urls[0]) {
      console.log('\n  Scan with your phone (same Wi-Fi):');
      qrcode.generate(urls[0], { small: true });
    } else {
      console.log('\n  No Wi-Fi/LAN address found. Connect to Wi-Fi to open it on your phone.');
    }
    console.log(`  YouTube key: ${config.YOUTUBE_API_KEY ? 'set' : 'NOT set (radar will use HN, Reddit, GitHub only)'}`);
    await watcher.start(getSetting(db, 'watch_dir', config.WATCH_DIR));
    scheduleRadar(db);
    console.log(`[radar] scheduled daily at 07:00 ${config.TIMEZONE}\n`);
  }).on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${config.PORT} is busy. Set PORT=3001 in .env or close the other app.` : e);
    process.exit(1);
  });

  const shutdown = async () => { await watcher.stop(); db.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createApp, lanUrls };
