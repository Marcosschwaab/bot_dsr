/**
 * bot.js - Gerencia envios para múltiplos servidores e usa imagem de mapa específica (map_image).
 */

const { Client, GatewayIntentBits, EmbedBuilder, Colors } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const TOKEN = process.env.DISCORD_TOKEN;

// --- CONFIGURAÇÃO DE MULTICAST ---
const SERVER_CONFIG = [
{ 
    name: 'DARK ARMY - DSR', 
    channelId: '1545897780336267355', 
    roleId: '1413665580661084261' 
  }
];

let readyPromise = null;
let lastMessages = {}; // Estrutura: jobKey -> { channelId: messageId }

function startClient() {
  if (readyPromise) return readyPromise;
  if (!TOKEN) {
    console.warn('DISCORD_TOKEN não configurado.');
    readyPromise = Promise.resolve();
    return readyPromise;
  }
  readyPromise = new Promise((resolve, reject) => {
    client.once('clientReady', () => {
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

async function sendEmbedAndSave(jobKey, baseContent, embed) {
  await startClient();
  if (!client || !client.channels) return null;

  if (!lastMessages[jobKey]) {
    lastMessages[jobKey] = {};
  }

  const promises = SERVER_CONFIG.map(async (config) => {
    try {
      const ch = await client.channels.fetch(config.channelId);
      
      // 1. Tenta deletar mensagem anterior DESTE canal (se existir)
      if (lastMessages[jobKey][config.channelId]) {
        try {
          const prev = await ch.messages.fetch(lastMessages[jobKey][config.channelId]).catch(() => null);
          if (prev) await prev.delete().catch(() => {});
        } catch (e) {
          // Ignora se já foi deletada
        }
        delete lastMessages[jobKey][config.channelId];
      }

      // 2. Prepara o conteúdo com a menção específica
      const mention = config.roleId ? `<@&${config.roleId}> ` : '';
      const finalContent = `${mention}${baseContent}`.trim();

      // 3. Envia a nova mensagem
      const sent = await ch.send({ content: finalContent, embeds: [embed] });
      
      // 4. Salva o ID
      lastMessages[jobKey][config.channelId] = sent.id;
      return sent;

    } catch (err) {
      console.error(`[Erro] Falha ao enviar para ${config.name} (Canal: ${config.channelId}):`, err.message);
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
}

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
  
  // Imagem do Boss (Thumbnail Pequena - Canto Superior Direito)
  if (raid.image) {
    try { embed.setThumbnail(raid.image); } catch(e){}
  }

  // Imagem do Mapa (Imagem Grande - Embaixo)
  // Usa o campo 'map_image' que vem do config.json através do scheduler
  if (raid.map_image) {
    try {
      embed.setImage(raid.map_image);
    } catch(e){}
  }

  return embed;
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

module.exports = { startClient, sendEmbedSequence, deleteMessageByJob };