/**
 * server.js - small express server that serves the web UI and starts the scheduler
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const scheduler = require('./scheduler');
const app = express();
const PORT = process.env.PORT || 3000;

app.use('/static', express.static(path.join(__dirname, '..', 'public')));

app.get('/api/raids', (req, res) => {
  res.json({ raids: scheduler.getUpcomingRaids() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, async ()=> {
  console.log(`Server running at http://localhost:${PORT}`);
  await scheduler.start();
  console.log('Scheduler started');
});
