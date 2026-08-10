# DSR Raid Bot

Bot de Discord para o jogo **Digimon Super Rumble (DSR)** que monitora os horários das raids (bosses) e envia alertas automáticos nos servidores, com:

- Contagens regressivas minuto a minuto (5, 4, 3, 2, 1 min antes do spawn).
- Mensagem de **"Raid Iniciada"** quando o boss aparece.
- Embed com **imagem do boss** (thumbnail) e **imagem do mapa** (imagem grande).
- Suporte a **vários servidores/canais ao mesmo tempo** (multicast).
- Atualização automática do agendamento a cada 10 minutos.
- Página web local para pré-visualizar as próximas raids.

---

## Como funciona

O projeto tem 4 peças principais:

| Arquivo | Função |
|---|---|
| `src/server.js` | Servidor **Express** que serve a página web (`public/index.html`) e inicia o agendador. |
| `src/scheduler.js` | Combina os dados do `config.json` com o scraper e agenda os alertas minuto a minuto. |
| `src/scraper.js` | Raspá (`scrape`) o site `dsrworldwiki.com` para descobrir raids que não estão no `config.json`. |
| `src/bot.js` | Loga no Discord e envia/deleta as mensagens de alerta nos canais configurados. |

Fluxo:

```
server.js
  └─ scheduler.start()
       ├─ lê config.json (raids manual/cycling/biweekly/weekly)
       ├─ scraper busca raids extras no site
       ├─ combina tudo e ordena por horário
       └─ agenda jobs (5→1 min antes + "começou")
            └─ bot.js envia Embed para todos os canais
                 └─ apaga a mensagem anterior do mesmo job ao enviar a nova
```

---

## Configurando as raids (`config.json`)

Todas as raids que **não** estão no site (ou que você quer garantir/alimentar manualmente) são declaradas em `config.json`, separadas por tipo de recorrência:

| Chave | Tipo | Descrição |
|---|---|---|
| `manual_raids` | array | Raids em horário fixo todo dia. Campos: `name`, `map`, `spawn_local` (`HH:mm`), `reward`, `reward_emote`, `emote`, `image`, `map_image`. |
| `cycling_rules` | array | Raids que avançam X minutos por dia (ex.: Hippogryphonmon). Campos: `name`, `map`, `base_time`, `increment_minutes`, `cycle_steps`, `reference_date`, `reference_step`, `image`, `map_image`, `reward`. O horário do dia é `base_time + (passo_do_dia × increment_minutes)`, onde o passo do dia é `(reference_step + dias desde reference_date) % cycle_steps`. |
| `biweekly_rules` | array | Raids que alternam entre um par de bosses a cada ~15 dias. Campos: `name`, `time`, `referenceDate`, `weekLengthDays`, `pair` (2 nomes), `images`, `map_images`, `maps`, `rewards`, `emotes`. |
| `weekly_alternating_rules` | array | Raids semanais que alternam entre um par de bosses pela semana (ex.: domingo = Omegamon ou Megidramon). Campos: `dayOfWeek` (1=seg, 7=dom), `time`, `referenceDate`, `pair`, `images`, `map_images`, `maps`, `rewards`, `emotes`. |

> As imagens (`image` = boss, `map_image` = mapa) são opcionais — o embed usa thumbnail (`image`) e imagem grande (`map_image`).

---

## Requisitos

- **Node.js 18+** (testado com Node 23)
- **npm** (vem junto com o Node)
- Um **token de bot do Discord** (veja abaixo)
---

## Rodando o projeto do zero

### 1. Instalar o Node.js

Se ainda não tem o Node instalado:

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y nodejs npm
```

Confirme que instalou:

```bash
node --version   # >= 18
npm --version
```

### 2. Clonar / baixar o projeto

```bash
git clone <url-do-repositorio> dsr_raid
cd dsr_raid
```

### 3. Instalar as dependências

```bash
npm install
```

Isso lê o `package.json` e instala: `axios`, `cheerio`, `discord.js`, `dotenv`, `express`, `luxon` e `node-schedule`.

### 4. Configurar o arquivo `.env`

Crie um arquivo `.env` na raiz do projeto (o arquivo não deve ser versionado — está no `.gitignore`):

```env
# Token do seu bot do Discord (obrigatório)
DISCORD_TOKEN=SEU_TOKEN_AQUI

# Fuso horário dos horários das raids (padrão: America/Sao_Paulo)
TIMEZONE=America/Sao_Paulo

# Porta do servidor web local (padrão: 3000)
PORT=3000
```

> **Como conseguir o token do bot:**
> 1. Acesse https://discord.com/developers/applications e crie uma aplicação.
> 2. Vá em **Bot** → **Reset Token** e copie o token.
> 3. Na mesma tela, ative as intents **Presence**, **Server Members** e **Message Content**.
> 4. Use o **OAuth2 → URL Generator** para convidar o bot para o seu servidor (scopes: `bot` + `applications.commands`; permissão de enviar mensagens e apagar mensagens).
> 5. Guarde o token no `.env` — **nunca** suba o token para o repositório.

### 5. Configurar os canais do bot

Edite o array `SERVER_CONFIG` em `src/bot.js` (linhas ~10-21) com os canais e cargos do seu servidor:

```js
const SERVER_CONFIG = [
  { name: 'Servidor Principal', channelId: 'ID_DO_CANAL', roleId: 'ID_DO_CARGO' },
  { name: 'Servidor Novo',     channelId: 'ID_DO_CANAL', roleId: 'ID_DO_CARGO' }
];
```

Para descobrir os IDs, no Discord ative o **Modo Desenvolvedor** (Ajustes → Avançado) e clique com o botão direito no canal/cargo → **Copiar ID**.

### 6. Rodar

```bash
npm start
```

Esperado no terminal:

```
Server running at http://localhost:3000
...
Discord client ready as NomedeBotXXX
Bot configurado para enviar alertas em 2 canais.
Scheduler started
```

Abra http://localhost:3000 para ver a pré-visualização das próximas raids.

> Para rodar em segundo plano no servidor: `npm start > bot.log 2>&1 &` ou use `pm2` (`npm i -g pm2 && pm2 start src/server.js --name dsr-bot`).
