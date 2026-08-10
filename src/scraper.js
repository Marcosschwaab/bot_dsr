/**
 * scraper.js
 * Heuristically parses dsrworldwiki.com/en/home to extract raid entries including image URL.
 * Returns array of { name, spawn_local (HH:mm), map, reward, image }
 */

const axios = require('axios');
const cheerio = require('cheerio');

async function fetchRaidsFromSite() {
  try {
    const res = await axios.get('https://dsrworldwiki.com/en/home', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const raids = [];

    // Try common card selectors
    $('[class*=raid], [class*=card], .raid-item, .raid-card, .event-card, .spawn-card').each((i, el) => {
      const el$ = $(el);
      const bossName = el$.find('h3, h2, .title, .name').first().text().trim() || null;
      const text = el$.text();
      const reLocal = /Spawn\s*\(Local\).*?([0-2]?\d:[0-5]\d)/i;
      const reAny = /Spawn.*?([0-2]?\d:[0-5]\d)/i;
      const mLocal = text.match(reLocal);
      const mAny = text.match(reAny);
      let spawnLocal = null;
      if (mLocal) spawnLocal = mLocal[1];
      else if (mAny) spawnLocal = mAny[1];
      const map = el$.find('.map, .meta-map, .map-name').first().text().trim() || null;
      const reward = el$.find('.reward, .meta-reward').first().text().trim() || null;

      // try to get an image URL from <img> inside the card
      let image = null;
      const img = el$.find('img').first();
      if (img && img.attr('src')) {
        image = img.attr('src').trim();
        // convert relative urls to absolute if needed
        if (image && image.startsWith('/')) image = 'https://dsrworldwiki.com' + image;
      }

      if (bossName && spawnLocal) {
        raids.push({ name: bossName, spawn_local: spawnLocal, map, reward, image });
      }
    });

    // fallback simple text scan
    if (raids.length === 0) {
      const body = $('body').text();
      const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const m = line.match(/^([A-Za-z0-9\-\s:]+)\s+Spawn.*?([0-2]?\d:[0-5]\d)/);
        if (m) raids.push({ name: m[1].trim(), spawn_local: m[2], map: null, reward: null, image: null });
      }
    }

    return raids;
  } catch (err) {
    console.warn('scraper error:', err.message);
    return [];
  }
}

module.exports = { fetchRaidsFromSite };
