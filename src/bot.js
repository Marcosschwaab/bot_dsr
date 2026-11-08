/**
 * bot.js - Gerencia envios para múltiplos servidores, card padrão de raids e card especial de 3 blocos para DG fixa.
 */

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder, Colors } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const TOKEN = process.env.DISCORD_TOKEN;

// --- CONFIGURAÇÃO DE MULTICAST ---
const SERVER_CONFIG = [
  { 
    name: 'DARK ARMY - DSR', 
    channelId: '1545897780336267355', 
    roleId: '1413665580661084261' 
  }
];

const MSG_STORE_PATH = path.join(__dirname, '..', 'active_messages.json');

let readyPromise = null;
let lastMessages = {}; // Estrutura: jobKey -> { channelId: messageId }
let testMsgRef = null; // Referência para o comando !testedg

function loadStoredMessages() {
  try {
    if (fs.existsSync(MSG_STORE_PATH)) {
      lastMessages = JSON.parse(fs.readFileSync(MSG_STORE_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('Erro ao carregar active_messages.json:', e.message);
    lastMessages = {};
  }
}

function saveStoredMessages() {
  try {
    fs.writeFileSync(MSG_STORE_PATH, JSON.stringify(lastMessages, null, 2), 'utf-8');
  } catch (e) {
    console.error('Erro ao salvar active_messages.json:', e.message);
  }
}

loadStoredMessages();

// Comandos de teste direto no Discord (!testedg e !apagardg) sem dar ping no cargo
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content === '!testedg') {
    try {
      const configPath = path.join(__dirname, '..', 'config.json');
      const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const dgRule = (currentConfig.persistent_weekly_rules || [])[0];

      if (!dgRule) {
        return message.reply('⚠️ Nenhuma regra encontrada em `persistent_weekly_rules` no seu `config.json`.');
      }

      const embeds = buildPersistentEmbeds(dgRule);
      const emote = dgRule.emote ? `${dgRule.emote} ` : '';
      testMsgRef = await message.channel.send({
        content: `🛠️ **[MODO TESTE - SEM PING]** ${emote}🔓 **A Dungeon Especial está ABERTA!** (Disponível de Quinta 12:00 até Sexta 12:00)`,
        embeds: embeds
      });
    } catch (err) {
      console.error('Erro no !testedg:', err);
      message.reply(`Erro ao gerar preview: ${err.message}`);
    }
  }

  if (message.content === '!apagardg') {
    if (testMsgRef) {
      await testMsgRef.delete().catch(() => {});
      testMsgRef = null;
      await message.reply('✅ Card de teste apagado com sucesso!');
    } else {
      await message.reply('Nenhuma mensagem de teste ativa para apagar.');
    }
  }
});

function startClient() {
  if (readyPromise) return readyPromise;
  if (!TOKEN) {
    console.warn('DISCORD_TOKEN não configurado.');
    readyPromise = Promise.resolve();
    return readyPromise;
  }
  readyPromise = new Promise((resolve, reject) => {
    client.once('ready', () => {
      console.log(`Discord client ready as ${client.user.tag}`);
      console.log(`Bot configurado para enviar alertas em ${SERVER_CONFIG.length} canais.`);
      resolve();
    });
    client.login(TOKEN).catch(err => {
      console.error('Discord login error:', err);
      reject(err);
    });
  });
  return readyPromise;
}

// Envio padrão (1 embed) para os bosses normais
async function sendEmbedAndSave(jobKey, baseContent, embed) {
  await startClient();
  if (!client || !client.channels) return null;

  if (!lastMessages[jobKey]) {
    lastMessages[jobKey] = {};
  }

  const promises = SERVER_CONFIG.map(async (config) => {
    try {
      const ch = await client.channels.fetch(config.channelId);
      
      if (lastMessages[jobKey][config.channelId]) {
        try {
          const prev = await ch.messages.fetch(lastMessages[jobKey][config.channelId]).catch(() => null);
          if (prev) await prev.delete().catch(() => {});
        } catch (e) {}
        delete lastMessages[jobKey][config.channelId];
      }

      const mention = config.roleId ? `<@&${config.roleId}> ` : '';
      const finalContent = `${mention}${baseContent}`.trim();

      const sent = await ch.send({ content: finalContent, embeds: [embed] });
      
      lastMessages[jobKey][config.channelId] = sent.id;
      saveStoredMessages();
      return sent;

    } catch (err) {
      console.error(`[Erro] Falha ao enviar para ${config.name} (Canal: ${config.channelId}):`, err.message);
      return null;
    }
  });

  return Promise.allSettled(promises);
}

// Envio especial (3 blocos na mesma mensagem) para a DG de Quinta-feira
async function sendPersistentEmbedAndSave(jobKey, baseContent, raid) {
  await startClient();
  if (!client || !client.channels) return null;

  if (!lastMessages[jobKey]) {
    lastMessages[jobKey] = {};
  }

  const embeds = buildPersistentEmbeds(raid);

  const promises = SERVER_CONFIG.map(async (config) => {
    try {
      const ch = await client.channels.fetch(config.channelId);
      
      if (lastMessages[jobKey][config.channelId]) {
        try {
          const prev = await ch.messages.fetch(lastMessages[jobKey][config.channelId]).catch(() => null);
          if (prev) await prev.delete().catch(() => {});
        } catch (e) {}
        delete lastMessages[jobKey][config.channelId];
      }

      const mention = config.roleId ? `<@&${config.roleId}> ` : '';
      const finalContent = `${mention}${baseContent}`.trim();

      const sent = await ch.send({ content: finalContent, embeds: embeds });
      
      lastMessages[jobKey][config.channelId] = sent.id;
      saveStoredMessages();
      return sent;

    } catch (err) {
      console.error(`[Erro] Falha ao enviar DG fixa para ${config.name} (Canal: ${config.channelId}):`, err.message);
      return null;
    }
  });

  return Promise.allSettled(promises);
}

async function deleteMessageByJob(jobKey) {
  await startClient();
  if (!client || !client.channels) return;

  const channelMap = lastMessages[jobKey];
  if (!channelMap) return;

  const promises = Object.entries(channelMap).map(async ([channelId, messageId]) => {
    try {
      const ch = await client.channels.fetch(channelId);
      const msg = await ch.messages.fetch(messageId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    } catch (err) {
      console.error(`Erro ao deletar mensagem antiga no canal ${channelId}:`, err.message);
    }
  });

  await Promise.allSettled(promises);
  delete lastMessages[jobKey];
  saveStoredMessages();
}

// Card padrão dos bosses normais (inalterado)
function buildEmbed(raid, titleSuffix) {
  const title = `${raid.name}`; 
  const descLines = [];
  
  if (raid.map) descLines.push(`📍 **${raid.map}**`);
  if (raid.spawn_local) descLines.push(`⏰ **${raid.spawn_local}** (GMT-3)`);
  
  if (raid.reward) {
    const rewardEmote = raid.reward_emote || '🏆';
    descLines.push(`${rewardEmote} **${raid.reward}**`.trim());
  }

  if (titleSuffix) {
    if (titleSuffix === 'COMEÇOU') {
      descLines.push(`✅ **Raid Iniciada!**`);
    } else {
      descLines.push(`⏳ **Em ${titleSuffix}**`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(descLines.join('\n\n'))
    .setColor(Colors.DarkOrange)
    .setFooter({ text: 'DSR Raid Alert | Done by Douleur' });
  
  if (raid.image) {
    try { embed.setThumbnail(raid.image); } catch(e){}
  }

  if (raid.map_image) {
    try { embed.setImage(raid.map_image); } catch(e){}
  }

  return embed;
}

// Card Especial de 3 Blocos para a DG de Quinta-feira
function buildPersistentEmbeds(raid) {
  const embeds = [];
  const color = raid.color || Colors.Red;

  // BLOCO 1: Nome da DG grande (#) + Nome do Boss (##) + GIF de Apresentação
  const headerText = `# ${raid.dg_name || '🏰 Dungeon Especial'}\n## ${raid.name || 'Boss'}`;
  const topEmbed = new EmbedBuilder()
    .setDescription(headerText)
    .setColor(color);

  if (raid.gif) {
    try { topEmbed.setImage(raid.gif); } catch (e) {}
  }
  embeds.push(topEmbed);

  // BLOCO 2: Mapas Lado a Lado (Entrada da DG na esquerda + Mapa Interno na direita)
  const sharedMapUrl = 'https://dsrworldwiki.com/en/home#dg-maps';
  if (raid.entry_map_image || raid.inside_map_image) {
    const mapEmbedLeft = new EmbedBuilder()
      .setURL(sharedMapUrl)
      .setColor(color)
      .setDescription(raid.map_header || '📍 **Esquerda:** Entrada da DG | 🗺️ **Direita:** Mapa Interno');

    if (raid.entry_map_image) {
      try { mapEmbedLeft.setImage(raid.entry_map_image); } catch (e) {}
    }
    embeds.push(mapEmbedLeft);

    if (raid.inside_map_image) {
      const mapEmbedRight = new EmbedBuilder()
        .setURL(sharedMapUrl)
        .setColor(color)
        .setImage(raid.inside_map_image);
      embeds.push(mapEmbedRight);
    }
  }

  // BLOCO 3: Descrição das Recompensas + Imagem com todas as Recompensas no final
  const rewardEmbed = new EmbedBuilder()
    .setColor(color)
    .setDescription(raid.rewards_description || '🏆 **Recompensas da Dungeon**')
    .setFooter({ text: 'DSR Evento Semanal Fixo | Quinta 12:00 até Sexta 12:00 (GMT-3)' });

  if (raid.rewards_image) {
    try { rewardEmbed.setImage(raid.rewards_image); } catch (e) {}
  }
  embeds.push(rewardEmbed);

  return embeds;
}

async function sendEmbedSequence(jobKey, raid) {
  return {
    sendSingle: async (contentSuffix, titleSuffix) => {
      const baseContent = (raid.emote || '') + ' ' + (contentSuffix || '');
      const embed = buildEmbed(raid, titleSuffix);
      return await sendEmbedAndSave(jobKey, baseContent.trim(), embed);
    },
    deleteLast: async () => {
      return await deleteMessageByJob(jobKey);
    }
  };
}

module.exports = {
  startClient,
  sendEmbedSequence,
  sendPersistentEmbedAndSave,
  deleteMessageByJob
};