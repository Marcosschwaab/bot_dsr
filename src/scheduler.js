/**
 * scheduler.js
 * Combines scraping + config rules and schedules minute-by-minute alerts.
 * Captures 'map_image' from config and passes it to the bot.
 */

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const schedule = require('node-schedule');
const scraper = require('./scraper');
const bot = require('./bot');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

let upcomingRaids = [];
let scheduledJobRefs = {}; 

function biweeklyChoice(rule, date = DateTime.now().setZone(TIMEZONE)) {
  const ref = DateTime.fromISO(rule.referenceDate, { zone: TIMEZONE }).startOf('day');
  const diffDays = Math.floor(date.startOf('day').diff(ref, 'days').days);
  const interval = rule.weekLengthDays || 15;
  const index = Math.floor(diffDays / interval) % rule.pair.length;
  return { choice: rule.pair[index], index: index };
}

function nextDateForTime(hhmm, referenceDate = DateTime.now().setZone(TIMEZONE)) {
  const [hh, mm] = hhmm.split(':').map(n => parseInt(n, 10));
  let dt = referenceDate.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  if (dt <= DateTime.now().setZone(TIMEZONE)) dt = dt.plus({ days: 1 });
  return dt;
}

function getCyclingTime(rule, targetDate) {
  const today = (targetDate || DateTime.now().setZone(TIMEZONE)).startOf('day');
  const refDate = DateTime.fromISO(rule.reference_date, { zone: TIMEZONE }).startOf('day');
  const diffDays = Math.floor(today.diff(refDate, 'days').days);
  let currentStep = (rule.reference_step + diffDays) % rule.cycle_steps;
  if (currentStep < 0) currentStep += rule.cycle_steps;
  const minsToAdd = currentStep * rule.increment_minutes;
  const [baseH, baseM] = rule.base_time.split(':').map(Number);
  const baseDt = today.set({ hour: baseH, minute: baseM });
  return baseDt.plus({ minutes: minsToAdd }).toFormat('HH:mm');
}

async function buildUpcoming() {
  const site = await scraper.fetchRaidsFromSite();
  const result = [];
  const today = DateTime.now().setZone(TIMEZONE);

  // 1. Manual raids (fixas)
  for (const m of CONFIG.manual_raids || []) {
    const spawnDt = nextDateForTime(m.spawn_local);
    result.push({ 
      name: m.name, 
      map: m.map||'', 
      spawn_local: m.spawn_local, 
      spawn_dt: spawnDt.toISO(), 
      reward: m.reward||'', 
      reward_emote: m.reward_emote||'', 
      emote: m.emote||'', 
      image: m.image||'',
      map_image: m.map_image || '' // Lê a imagem específica do mapa
    });
  }

  // 2. Cycling rules (WaruMonzaemon / Hippogryphonmon)
  for (const c of CONFIG.cycling_rules || []) {
    let timeLocal = getCyclingTime(c);
    let spawnDt = nextDateForTime(timeLocal);
    
    // Ajuste Cirúrgico: Se o horário de hoje já passou e pulou pro dia seguinte, calcula o passo de amanhã
    const now = DateTime.now().setZone(TIMEZONE);
    if (spawnDt.day !== now.day) {
      const tomorrow = now.plus({ days: 1 });
      timeLocal = getCyclingTime(c, tomorrow);
      spawnDt = nextDateForTime(timeLocal, tomorrow);
    }
    
    result.push({
      name: c.name,
      map: c.map || '',
      spawn_local: timeLocal,
      spawn_dt: spawnDt.toISO(),
      reward: c.reward || '',
      reward_emote: c.reward_emote || '',
      emote: c.emote || '',
      image: c.image || '',
      map_image: c.map_image || ''
    });
  }

  // 3. Site raids (scraper)
  for (const s of site) {
    const dup = result.find(r => r.name.toLowerCase() === s.name.toLowerCase() && r.spawn_local === s.spawn_local);
    if (!dup) {
      const spawnDt = nextDateForTime(s.spawn_local);
      result.push({ 
        name: s.name, 
        map: s.map||'', 
        spawn_local: s.spawn_local, 
        spawn_dt: spawnDt.toISO(), 
        reward: s.reward||'', 
        reward_emote: '', 
        emote: '', 
        image: s.image||'',
        map_image: '' // Scraper não tem imagem de mapa específica
      });
    } else {
      if (!dup.image && s.image) dup.image = s.image;
    }
  }

  // 4. Biweekly rules
  for (const rule of CONFIG.biweekly_rules || []) {
    const { choice, index } = biweeklyChoice(rule);
    if (choice) {
      const spawnDt = nextDateForTime(rule.time);
      const chosenImage = (rule.images && rule.images[index]) || '';
      const chosenMapImage = (rule.map_images && rule.map_images[index]) || ''; // Pega do array map_images
      const chosenReward = (rule.rewards && rule.rewards[index]) || '';
      const chosenRewardEmote = (rule.reward_emotes && rule.reward_emotes[index]) || '';
      const chosenEmote = (rule.emotes && rule.emotes[index]) || '';
      const chosenMap = (rule.maps && rule.maps[index]) || '';
      
      result.push({ name: choice, map: chosenMap, spawn_local: rule.time, spawn_dt: spawnDt.toISO(), reward: chosenReward, reward_emote: chosenRewardEmote, emote: chosenEmote, image: chosenImage, map_image: chosenMapImage });
    }
  }

  // 5. Weekly alternating rules
  for (const rule of CONFIG.weekly_alternating_rules || []) {
    if (today.weekday === rule.dayOfWeek) {
      const ref = DateTime.fromISO(rule.referenceDate, { zone: TIMEZONE }).startOf('week');
      const diffWeeks = Math.floor(today.startOf('day').diff(ref, 'weeks').weeks);
      const index = diffWeeks % rule.pair.length;
      const choice = rule.pair[index];
      
      if (choice) {
        const spawnDt = nextDateForTime(rule.time);
        const chosenImage = (rule.images && rule.images[index]) || '';
        const chosenMapImage = (rule.map_images && rule.map_images[index]) || ''; // Pega do array map_images
        const chosenReward = (rule.rewards && rule.rewards[index]) || '';
        const chosenRewardEmote = (rule.reward_emotes && rule.reward_emotes[index]) || '';
        const chosenEmote = (rule.emotes && rule.emotes[index]) || '';
        const chosenMap = (rule.maps && rule.maps[index]) || '';
        
        result.push({ name: choice, map: chosenMap, spawn_local: rule.time, spawn_dt: spawnDt.toISO(), reward: chosenReward, reward_emote: chosenRewardEmote, emote: chosenEmote, image: chosenImage, map_image: chosenMapImage });
      }
    }
  }

  result.sort((a,b)=> new Date(a.spawn_dt)- new Date(b.spawn_dt));
  upcomingRaids = result.slice(0,50);
  return upcomingRaids;
}

function clearScheduledJobs() {
  for (const key in scheduledJobRefs) {
    const arr = scheduledJobRefs[key];
    for (const j of arr) {
      try { j.cancel(); } catch(e){}
    }
  }
  scheduledJobRefs = {};
}

async function scheduleAll() {
  console.log('Rebuilding schedule...');
  clearScheduledJobs();
  await bot.startClient();
  await buildUpcoming();
  const now = DateTime.now().setZone(TIMEZONE);

  for (const raid of upcomingRaids) {
    try {
      const spawn = DateTime.fromISO(raid.spawn_dt, { zone: TIMEZONE });
      const jobKey = `${raid.name.replace(/\s+/g,'_')}_${spawn.toISODate()}_${raid.spawn_local}`;
      scheduledJobRefs[jobKey] = [];
      for (let m=5; m>=1; m--) {
        const alertTime = spawn.minus({ minutes: m });
        if (alertTime <= now) continue;
        const job = schedule.scheduleJob(alertTime.toJSDate(), async () => {
          try {
            const seq = await bot.sendEmbedSequence(jobKey, raid);
            const contentSuffix = `Em **${m} minuto${m>1?'s':''}** começa a raid contra **${raid.name}**!`;
            await seq.sendSingle(contentSuffix, `${m} min`);
          } catch (e) { console.error('error in minute alert', e); }
        });
        scheduledJobRefs[jobKey].push(job);
      }
      if (spawn > now) {
        const jobSpawn = schedule.scheduleJob(spawn.toJSDate(), async () => {
          try {
            const seq = await bot.sendEmbedSequence(jobKey, raid);
            const contentSuffix = 'RAID COMEÇOU — ' + raid.name;
            await seq.sendSingle(contentSuffix, 'COMEÇOU');
            setTimeout(async ()=>{ await bot.deleteMessageByJob(jobKey); }, 1 * 60 * 1000);
          } catch (e) { console.error('error in spawn job', e); }
        });
        scheduledJobRefs[jobKey].push(jobSpawn);
      }
    } catch (err) {
      console.error('scheduleAll error for raid', raid, err);
    }
  }
}

module.exports = {
  start: async ()=>{
    await scheduleAll();
    schedule.scheduleJob('*/10 * * * *', scheduleAll);
  },
  getUpcomingRaids: ()=> upcomingRaids
};