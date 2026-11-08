/**
 * scheduler.js
 * Combines scraping + config rules, schedules Discord alerts, and builds the 7-day weekly preview.
 */

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const schedule = require('node-schedule');
const scraper = require('./scraper');
const bot = require('./bot');

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

let upcomingRaids = [];
let weeklySchedule = {}; // 1 (Segunda) a 7 (Domingo)
let scheduledJobRefs = {}; 

function getConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
}

function biweeklyChoice(rule, date = DateTime.now().setZone(TIMEZONE)) {
  const ref = DateTime.fromISO(rule.referenceDate, { zone: TIMEZONE }).startOf('day');
  const diffDays = Math.floor(date.startOf('day').diff(ref, 'days').days);
  const interval = rule.weekLengthDays || 15;
  const len = rule.pair.length;
  const index = ((Math.floor(diffDays / interval) % len) + len) % len;
  return { choice: rule.pair[index], index: index };
}

function nextDateForTime(hhmm, referenceDate = DateTime.now().setZone(TIMEZONE)) {
  const [hh, mm] = hhmm.split(':').map(n => parseInt(n, 10));
  let dt = referenceDate.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  if (dt <= DateTime.now().setZone(TIMEZONE)) dt = dt.plus({ days: 1 });
  return dt;
}

function nextWeekdayAndTime(targetWeekday, hhmm, referenceDate = DateTime.now().setZone(TIMEZONE)) {
  const [hh, mm] = hhmm.split(':').map(n => parseInt(n, 10));
  let dt = referenceDate.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  let daysToAdd = (targetWeekday - dt.weekday + 7) % 7;
  if (daysToAdd === 0 && dt <= referenceDate) {
    daysToAdd = 7;
  }
  return dt.plus({ days: daysToAdd });
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

// Monta a lista de raids de cada dia da semana (1 = Segunda ... 7 = Domingo) para o painel web
function buildWeeklySchedule(CONFIG, siteRaids) {
  const now = DateTime.now().setZone(TIMEZONE);
  const weekMap = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };

  for (let weekday = 1; weekday <= 7; weekday++) {
    // Calcula a data da próxima ocorrência desse dia da semana (ou hoje, se for o mesmo dia)
    const daysAhead = (weekday - now.weekday + 7) % 7;
    const targetDate = now.startOf('day').plus({ days: daysAhead });
    const dayRaids = [];

    const makeSpawnIso = (hhmm) => {
      const [hh, mm] = hhmm.split(':').map(Number);
      let dt = targetDate.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
      if (daysAhead === 0 && dt <= now) dt = dt.plus({ days: 7 });
      return dt.toISO();
    };

    // 1. Manual raids (aparecem todos os dias)
    for (const m of CONFIG.manual_raids || []) {
      dayRaids.push({
        type: 'normal',
        name: m.name,
        map: m.map || '',
        spawn_local: m.spawn_local,
        spawn_dt: makeSpawnIso(m.spawn_local),
        reward: m.reward || '',
        reward_emote: m.reward_emote || '',
        emote: m.emote || '',
        image: m.image || '',
        map_image: m.map_image || ''
      });
    }

    // 2. Cycling rules (calcula o horário exato para aquele dia da semana)
    for (const c of CONFIG.cycling_rules || []) {
      const timeLocal = getCyclingTime(c, targetDate);
      dayRaids.push({
        type: 'normal',
        name: c.name,
        map: c.map || '',
        spawn_local: timeLocal,
        spawn_dt: makeSpawnIso(timeLocal),
        reward: c.reward || '',
        reward_emote: c.reward_emote || '',
        emote: c.emote || '',
        image: c.image || '',
        map_image: c.map_image || ''
      });
    }

    // 3. Site raids (scraper)
    for (const s of siteRaids || []) {
      const dup = dayRaids.find(r => r.name.toLowerCase() === s.name.toLowerCase() && r.spawn_local === s.spawn_local);
      if (!dup) {
        dayRaids.push({
          type: 'normal',
          name: s.name,
          map: s.map || '',
          spawn_local: s.spawn_local,
          spawn_dt: makeSpawnIso(s.spawn_local),
          reward: s.reward || '',
          image: s.image || '',
          map_image: ''
        });
      }
    }

    // 4. Weekly alternating rules (mostra os bosses daquele dia da semana)
    for (const rule of CONFIG.weekly_alternating_rules || []) {
      if (rule.dayOfWeek === weekday) {
        const ref = DateTime.fromISO(rule.referenceDate, { zone: TIMEZONE }).startOf('week');
        const diffWeeks = Math.floor(targetDate.startOf('day').diff(ref, 'weeks').weeks);
        const len = rule.pair.length;
        const activeIndex = ((diffWeeks % len) + len) % len;

        // Adiciona os bosses configurados no par para você conseguir ver todos no painel
        rule.pair.forEach((bossName, idx) => {
          if (!bossName) return; // Ignora strings vazias como ""
          const isThisWeek = (idx === activeIndex);
          dayRaids.push({
            type: 'normal',
            name: bossName,
            map: (rule.maps && rule.maps[idx]) || '',
            spawn_local: rule.time,
            spawn_dt: makeSpawnIso(rule.time),
            reward: (rule.rewards && rule.rewards[idx]) || '',
            reward_emote: (rule.reward_emotes && rule.reward_emotes[idx]) || '',
            emote: (rule.emotes && rule.emotes[idx]) || '',
            image: (rule.images && rule.images[idx]) || '',
            map_image: (rule.map_images && rule.map_images[idx]) || '',
            rotation_badge: len > 1 ? (isThisWeek ? '✅ Ativo nesta semana' : '🔄 Próxima rotação') : ''
          });
        });
      }
    }

    // 5. Persistent Weekly Rules (DG Especial de Quinta-feira)
    for (const p of CONFIG.persistent_weekly_rules || []) {
      if ((p.spawn_day || 4) === weekday) {
        dayRaids.push({
          type: 'persistent_dg',
          dg_name: p.dg_name || '🏰 DUNGEON ESPECIAL',
          name: p.name || 'Boss',
          color: p.color || '#e74c3c',
          spawn_local: p.spawn_time || '12:00',
          delete_time: p.delete_time || '12:00',
          spawn_dt: makeSpawnIso(p.spawn_time || '12:00'),
          gif: p.gif || '',
          map_header: p.map_header || '',
          entry_map_image: p.entry_map_image || '',
          inside_map_image: p.inside_map_image || '',
          rewards_description: p.rewards_description || '',
          rewards_image: p.rewards_image || ''
        });
      }
    }

    dayRaids.sort((a, b) => a.spawn_local.localeCompare(b.spawn_local));
    weekMap[weekday] = dayRaids;
  }

  weeklySchedule = weekMap;
}

async function buildUpcoming() {
  const CONFIG = getConfig();
  const site = await scraper.fetchRaidsFromSite();
  const result = [];
  const today = DateTime.now().setZone(TIMEZONE);

  // Atualiza também a tabela semanal completa para a página web
  buildWeeklySchedule(CONFIG, site);

  // 1. Manual raids
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
      map_image: m.map_image || ''
    });
  }

  // 2. Cycling rules
  for (const c of CONFIG.cycling_rules || []) {
    let timeLocal = getCyclingTime(c);
    let spawnDt = nextDateForTime(timeLocal);
    
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
        map_image: ''
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
      const chosenMapImage = (rule.map_images && rule.map_images[index]) || '';
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
      const len = rule.pair.length;
      const index = ((diffWeeks % len) + len) % len;
      const choice = rule.pair[index];
      
      if (choice) {
        const spawnDt = nextDateForTime(rule.time);
        const chosenImage = (rule.images && rule.images[index]) || '';
        const chosenMapImage = (rule.map_images && rule.map_images[index]) || '';
        const chosenReward = (rule.rewards && rule.rewards[index]) || '';
        const chosenRewardEmote = (rule.reward_emotes && rule.reward_emotes[index]) || '';
        const chosenEmote = (rule.emotes && rule.emotes[index]) || '';
        const chosenMap = (rule.maps && rule.maps[index]) || '';
        
        result.push({ name: choice, map: chosenMap, spawn_local: rule.time, spawn_dt: spawnDt.toISO(), reward: chosenReward, reward_emote: chosenRewardEmote, emote: chosenEmote, image: chosenImage, map_image: chosenMapImage });
      }
    }
  }

  result.sort((a,b)=> new Date(a.spawn_dt) - new Date(b.spawn_dt));
  upcomingRaids = result.slice(0,50);
  return upcomingRaids;
}

function clearScheduledJobs() {
  const nowMs = Date.now();
  for (const key in scheduledJobRefs) {
    const arr = scheduledJobRefs[key];
    scheduledJobRefs[key] = arr.filter(j => {
      if (!j) return false;
      const next = j.nextInvocation ? j.nextInvocation() : null;
      if (next) {
        const diff = next.getTime() - nowMs;
        if (diff <= 15000 && diff >= -5000) return true;
      }
      try { j.cancel(); } catch(e){}
      return false;
    });
    if (scheduledJobRefs[key].length === 0) {
      delete scheduledJobRefs[key];
    }
  }
}

async function scheduleAll() {
  console.log('Rebuilding schedule...');
  clearScheduledJobs();
  await bot.startClient();
  await buildUpcoming();
  const CONFIG = getConfig();
  const now = DateTime.now().setZone(TIMEZONE);

  // Agendamento padrão dos bosses normais
  for (const raid of upcomingRaids) {
    try {
      const spawn = DateTime.fromISO(raid.spawn_dt, { zone: TIMEZONE });
      const jobKey = `${raid.name.replace(/\s+/g,'_')}_${spawn.toISODate()}_${raid.spawn_local}`;
      if (scheduledJobRefs[jobKey] && scheduledJobRefs[jobKey].length > 0) continue;
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

  // Agendamento Exclusivo: DG Fixa Semanal (Quinta 12:00 -> Sexta 12:00)
  for (const p of CONFIG.persistent_weekly_rules || []) {
    try {
      const jobKey = `PERSISTENT_${(p.dg_name || p.name || 'DG').replace(/\s+/g, '_')}`;
      if (scheduledJobRefs[jobKey] && scheduledJobRefs[jobKey].length > 0) continue;
      scheduledJobRefs[jobKey] = [];

      const nextSpawn = nextWeekdayAndTime(p.spawn_day || 4, p.spawn_time || '12:00', now);
      const nextDelete = nextWeekdayAndTime(p.delete_day || 5, p.delete_time || '12:00', now);

      const jobSpawn = schedule.scheduleJob(nextSpawn.toJSDate(), async () => {
        try {
          const emote = p.emote ? `${p.emote} ` : '';
          const contentSuffix = `${emote}🔓 **A Dungeon Especial está ABERTA!** (Disponível até Sexta-feira às ${p.delete_time || '12:00'})`;
          await bot.sendPersistentEmbedAndSave(jobKey, contentSuffix, p);
        } catch (e) {
          console.error('Erro no envio da DG persistente:', e);
        }
      });

      const jobDelete = schedule.scheduleJob(nextDelete.toJSDate(), async () => {
        try {
          await bot.deleteMessageByJob(jobKey);
        } catch (e) {
          console.error('Erro ao deletar DG persistente:', e);
        }
      });

      scheduledJobRefs[jobKey].push(jobSpawn, jobDelete);
    } catch (err) {
      console.error('Erro ao agendar persistent_weekly_rule:', p, err);
    }
  }
}

module.exports = {
  start: async ()=>{
    await scheduleAll();
    schedule.scheduleJob('*/10 * * * *', scheduleAll);
  },
  getUpcomingRaids: ()=> upcomingRaids,
  getWeeklySchedule: ()=> weeklySchedule
};