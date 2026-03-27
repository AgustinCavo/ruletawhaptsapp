require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode   = require('qrcode-terminal');
const cron     = require('node-cron');
const readline = require('readline');
const db       = require('./db');
const game      = require('./game');
const diceguess = require('./diceguess');

// ─── Cliente WhatsApp ────────────────────────────────────────────────────────
const puppeteerArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
const puppeteerConfig = process.env.PUPPETEER_EXECUTABLE_PATH
  ? { headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args: puppeteerArgs }
  : { headless: true, args: puppeteerArgs };

const client = new Client({
  authStrategy: new LocalAuth(),
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  },
  puppeteer: puppeteerConfig,
});

client.on('qr', (qr) => {
  console.log('\nEscaneá este QR con WhatsApp Web:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  if (!process.env.GROUP_ID) {
    const chats  = await client.getChats();
    const groups = chats.filter(c => c.isGroup);

    console.log('\n⚠️  GROUP_ID no está configurado en .env\n');
    console.log('📋 Grupos disponibles:');
    groups.forEach(g => console.log(`  "${g.name}" → ${g.id._serialized}`));
    console.log('\nCopiá el ID del grupo que querés y pegalo en .env como GROUP_ID=...\n');
    console.log('❌ El bot no arranca sin GROUP_ID. Configuralo y reiniciá.');
    process.exit(0);
  }

  console.log('🎰 Bot de Ruleta listo!\n');
  scheduleWeeklyPoints();
});

client.on('auth_failure', () => console.error('❌ Error de autenticación'));
client.on('disconnected', (r) => console.log('Desconectado:', r));

// ─── Repartición semanal (viernes 9am ARG) ───────────────────────────────────
function scheduleWeeklyPoints() {
  cron.schedule('0 9 * * 5', async () => {
    const count = await db.giveWeeklyPoints();
    console.log(`💰 Cavopoints semanales distribuidos a ${count} usuarios`);

    const allowedGroups = process.env.GROUP_ID.split(',').map(s => s.trim());
    for (const groupId of allowedGroups) {
      try {
        const chat = await client.getChatById(groupId);
        await chat.sendMessage(
          '💰 *¡Feliz viernes!*\n\n' +
          'Se acreditaron *20.000 cavopoints* a todos los jugadores. ¡A romperla en la ruleta! 🎰'
        );
      } catch (e) {
        console.error(`No se pudo notificar al grupo ${groupId}:`, e.message);
      }
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });
}

// ─── Emojis de mano (cualquier tono de piel) ─────────────────────────────────
const HAND_EMOJIS = new Set([
  '👋','👋🏻','👋🏼','👋🏽','👋🏾','👋🏿',
  '✋','✋🏻','✋🏼','✋🏽','✋🏾','✋🏿',
  '🤚','🤚🏻','🤚🏼','🤚🏽','🤚🏾','🤚🏿',
  '🖐️','🖐🏻','🖐🏼','🖐🏽','🖐🏾','🖐🏿',
]);

// ─── Votaciones de kick ───────────────────────────────────────────────────────
const kickVotes   = new Map();
// chatId -> { votes: Set, messageId, needed, timer }
const launchVotes     = new Map();
const launchDiceVotes = new Map();

const CHECK_EMOJIS = new Set(['✅','☑️','✔️']);
const STOP_EMOJIS  = new Set(['🛑','⛔','🚫']);

async function isAdmin(chatId, userId) {
  try {
    const chat = await client.getChatById(chatId);
    const p = (chat.participants || []).find(p => p.id._serialized === userId);
    return p?.isAdmin || p?.isSuperAdmin || false;
  } catch { return false; }
}

async function doKick(targetId, vote) {
  clearTimeout(vote.timer);
  kickVotes.delete(targetId);
  try {
    const chat = await client.getChatById(vote.chatId);
    await chat.removeParticipants([targetId]);
    await chat.sendMessage('✅ El usuario fue echado del grupo.');
  } catch (e) {
    const chat = await client.getChatById(vote.chatId);
    await chat.sendMessage(`❌ No se pudo echar al usuario: ${e.message}`);
  }
}

client.on('message_reaction', async (reaction) => {
  // ── Votación de kick (mano ✋ + overrides de admin) ───────────────────────
  for (const [targetId, vote] of kickVotes.entries()) {
    if (vote.messageId !== reaction.msgId._serialized) continue;
    if (reaction.senderId === targetId) break;

    // Admin pone ✅ → kick inmediato
    if (CHECK_EMOJIS.has(reaction.reaction) && await isAdmin(vote.chatId, reaction.senderId)) {
      await doKick(targetId, vote);
      break;
    }

    // Admin pone 🛑 → cancelar votación
    if (STOP_EMOJIS.has(reaction.reaction) && await isAdmin(vote.chatId, reaction.senderId)) {
      clearTimeout(vote.timer);
      kickVotes.delete(targetId);
      const chat = await client.getChatById(vote.chatId);
      await chat.sendMessage('🚫 Votación de kick cancelada por un admin.');
      break;
    }

    // Mano de cualquier color → voto
    if (HAND_EMOJIS.has(reaction.reaction)) {
      if (reaction.orphan) {
        vote.votes.delete(reaction.senderId);
      } else {
        vote.votes.add(reaction.senderId);
      }

      if (vote.votes.size >= vote.needed) {
        await doKick(targetId, vote);
      }
    }
    break;
  }

  // ── Votación de launch ruleta / diceguess (mano ✋ de cualquier color) ─────
  if (HAND_EMOJIS.has(reaction.reaction)) {
    for (const [votes, label, onReach] of [
      [launchVotes,     'ruleta',    async (chat) => { await chat.sendMessage('✅ *¡Se alcanzó el quórum!* Iniciando ruleta...'); await game.startGame(chat); }],
      [launchDiceVotes, 'diceguess', async (chat) => { await chat.sendMessage('✅ *¡Se alcanzó el quórum!* Iniciando DiceGuess...'); await diceguess.startGame(chat); }],
    ]) {
      for (const [chatId, vote] of votes.entries()) {
        if (vote.messageId !== reaction.msgId._serialized) continue;

        if (reaction.orphan) {
          vote.votes.delete(reaction.senderId);
        } else {
          vote.votes.add(reaction.senderId);
        }

        if (vote.votes.size >= vote.needed) {
          clearTimeout(vote.timer);
          votes.delete(chatId);
          try {
            const chat = await client.getChatById(chatId);
            await onReach(chat);
          } catch (e) {
            console.error(`Error al iniciar ${label} por votación:`, e.message);
          }
        }
        break;
      }
    }
  }
});

// ─── Mensajes ────────────────────────────────────────────────────────────────
client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat();
    if (!chat.isGroup) return;

    console.log(`[grupo] "${chat.name}" → ${chat.id._serialized}`);

    const allowedGroups = process.env.GROUP_ID ? process.env.GROUP_ID.split(',').map(s => s.trim()) : [];
    if (allowedGroups.length > 0 && !allowedGroups.includes(chat.id._serialized)) return;

    const body     = msg.body.trim().toLowerCase();
    const contact  = await msg.getContact();
    const userId   = contact.id._serialized;
    const userName = contact.pushname || contact.name || 'Anónimo';

    // ── /launch ──────────────────────────────────────────────────────────────
    if (body === '/launch') {
      const chatId = chat.id._serialized;

      if (launchVotes.has(chatId)) {
        await msg.reply('⚠️ Ya hay una votación de lanzamiento activa.');
        return;
      }

      if (game.isActive(chatId)) {
        await msg.reply('⚠️ Ya hay una ruleta activa.');
        return;
      }

      const totalMembers = chat.participants ? chat.participants.length : 10;
      const needed       = Math.max(Math.ceil(totalMembers * 0.1), 1);

      const voteMsg = await chat.sendMessage(
        `🗳️ *¿Arrancamos la ruleta?*\n\n` +
        `Reaccioná con ✋ para votar. Se necesita el *10% del grupo* (*${needed} votos*).\n` +
        `⏱ La votación dura *10 minutos*.`
      );

      launchVotes.set(chatId, {
        votes:     new Set(),
        messageId: voteMsg.id._serialized,
        needed,
        timer: setTimeout(async () => {
          launchVotes.delete(chatId);
          await chat.sendMessage('❌ No se alcanzó el quórum. La ruleta no arranca.');
        }, 10 * 60 * 1000),
      });
      return;
    }

    // ── /launch diceguess ────────────────────────────────────────────────────
    if (body === '/launch diceguess') {
      const chatId = chat.id._serialized;

      if (launchDiceVotes.has(chatId)) {
        await msg.reply('⚠️ Ya hay una votación de DiceGuess activa.');
        return;
      }

      if (diceguess.isActive(chatId)) {
        await msg.reply('⚠️ Ya hay un DiceGuess activo.');
        return;
      }

      const totalMembers = chat.participants ? chat.participants.length : 10;
      const needed       = Math.max(Math.ceil(totalMembers * 0.1), 1);

      const voteMsg = await chat.sendMessage(
        `🎲 *¿Arrancamos el DiceGuess?*\n\n` +
        `Reaccioná con ✋ para votar. Se necesita el *10% del grupo* (*${needed} votos*).\n` +
        `⏱ La votación dura *10 minutos*.`
      );

      launchDiceVotes.set(chatId, {
        votes:     new Set(),
        messageId: voteMsg.id._serialized,
        needed,
        timer: setTimeout(async () => {
          launchDiceVotes.delete(chatId);
          await chat.sendMessage('❌ No se alcanzó el quórum. El DiceGuess no arranca.');
        }, 10 * 60 * 1000),
      });
      return;
    }

    // ── /ruleta ──────────────────────────────────────────────────────────────
    if (body === '/ruleta') {
      const participant = chat.participants?.find(p => p.id._serialized === userId);
      if (!participant?.isAdmin && !participant?.isSuperAdmin) {
        await msg.reply('❌ Solo los admins pueden iniciar la ruleta.');
        return;
      }
      await game.startGame(chat);
      return;
    }

    // ── /cancelar ────────────────────────────────────────────────────────────
    if (body === '/cancelar') {
      const participant = chat.participants?.find(p => p.id._serialized === userId);
      if (!participant?.isAdmin && !participant?.isSuperAdmin) {
        await msg.reply('❌ Solo los admins pueden cancelar la ruleta.');
        return;
      }
      await game.cancelGame(chat);
      return;
    }

    // ── /diceguess ───────────────────────────────────────────────────────────
    if (body === '/diceguess') {
      const participant = chat.participants?.find(p => p.id._serialized === userId);
      if (!participant?.isAdmin && !participant?.isSuperAdmin) {
        await msg.reply('❌ Solo los admins pueden iniciar el DiceGuess.');
        return;
      }
      await diceguess.startGame(chat);
      return;
    }

    if (body === '/canceldiceguess') {
      const participant = chat.participants?.find(p => p.id._serialized === userId);
      if (!participant?.isAdmin && !participant?.isSuperAdmin) {
        await msg.reply('❌ Solo los admins pueden cancelar el DiceGuess.');
        return;
      }
      await diceguess.cancelGame(chat);
      return;
    }

    // ── /guess ───────────────────────────────────────────────────────────────
    if (body.startsWith('/guess ')) {
      const parts  = body.split(/\s+/);
      if (parts.length < 3) {
        await msg.reply('❌ Formato: `/guess <número> <apuesta>`\nEjemplo: `/guess 42 1000`');
        return;
      }
      const guess  = parseInt(parts[1]);
      const amount = parseInt(parts[2]);
      await diceguess.placeGuess(chat, msg, userId, userName, guess, amount);
      return;
    }

    // ── /bet o /apostar ──────────────────────────────────────────────────────
    if (body.startsWith('/bet ') || body.startsWith('/apostar ')) {
      const parts = body.split(/\s+/);
      if (parts.length < 3) {
        await msg.reply('❌ Formato: `/bet <monto> <tipo> [tipo2 ...]`\nEjemplo: `/bet 4000 d1 d2`');
        return;
      }
      const amount   = parseInt(parts[1]);
      const betTypes = parts.slice(2);
      for (const betType of betTypes) {
        await game.placeBet(chat, msg, userId, userName, amount, betType);
      }
      return;
    }

    // ── /saldo o /balance ────────────────────────────────────────────────────
    if (body === '/saldo' || body === '/balance') {
      await db.getOrCreateUser(userId, userName);
      const balance = await db.getBalance(userId);
      await msg.reply(`💰 *${userName}*, tu saldo: *${balance.toLocaleString('es-AR')} cavopoints*`);
      return;
    }

    // ── /ranking ─────────────────────────────────────────────────────────────
    if (body === '/top') {
      const users = (await db.getAllUsers()).slice(0, 10);
      if (users.length === 0) {
        await msg.reply('Todavía no hay jugadores registrados.');
        return;
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines  = users.map((u, i) =>
        `${medals[i] || `${i + 1}.`} *${u.name}*: ${u.balance.toLocaleString('es-AR')} cavopoints`
      );
      await chat.sendMessage('🏆 *TOP CAVOPOINTS:*\n\n' + lines.join('\n'));
      return;
    }

    // ── /give ─────────────────────────────────────────────────────────────────
    if (body.startsWith('/give ')) {
      const parts  = body.split(/\s+/);
      const amount = parseInt(parts[parts.length - 1]);
      if (parts.length < 3 || !Number.isInteger(amount) || amount <= 0) {
        await msg.reply('❌ Formato: `/give @usuario <cantidad>`\nEjemplo: `/give @Juan 1000`');
        return;
      }

      let target = null;
      if (msg.mentionedIds && msg.mentionedIds.length > 0) {
        const rawId = msg.mentionedIds[0];
        // Resolver el contacto para obtener el número de teléfono real (evita LIDs de Meta)
        let canonicalId = rawId;
        try {
          const targetContact = await client.getContactById(rawId);
          if (targetContact.number) {
            canonicalId = targetContact.number + '@c.us';
          }
        } catch { /* usar rawId si falla */ }

        if (!(await db.userExists(canonicalId))) {
          await msg.reply('❌ Ese usuario todavía no se registró. Que primero haga `/saldo`.');
          return;
        }
        const allUsers = await db.getAllUsers();
        const existing = allUsers.find(u => u.id === canonicalId);
        target = { id: canonicalId, name: existing?.name || canonicalId.split('@')[0] };
      } else {
        const targetName = parts.slice(1, parts.length - 1).join(' ');
        target = await db.findUserByName(targetName);
        if (!target) {
          await msg.reply(`❌ No encontré ningún jugador con el nombre *${targetName}*.\nTambién podés usar @mención.`);
          return;
        }
      }

      if (target.id === userId) {
        await msg.reply('❌ No podés darte puntos a vos mismo.');
        return;
      }

      if (!(await db.userExists(userId))) {
        await msg.reply('❌ Primero registrate con `/saldo`.');
        return;
      }
      const senderBalance = await db.getBalance(userId);
      if (senderBalance < amount) {
        await msg.reply(`❌ Saldo insuficiente. Tu saldo: *${senderBalance.toLocaleString('es-AR')} cavopoints*`);
        return;
      }

      await db.updateBalance(userId, -amount);
      await db.updateBalance(target.id, amount);

      await chat.sendMessage(
        `💸 *${userName}* le regaló *${amount.toLocaleString('es-AR')} cavopoints* a *${target.name}*!\n` +
        `💰 Saldo de ${userName}: ${(await db.getBalance(userId)).toLocaleString('es-AR')}\n` +
        `💰 Saldo de ${target.name}: ${(await db.getBalance(target.id)).toLocaleString('es-AR')}`
      );
      return;
    }

    // ── /giveall ──────────────────────────────────────────────────────────────
    if (body.startsWith('/giveall ')) {
      const parts  = body.split(/\s+/);
      const amount = parseInt(parts[1]);
      if (!Number.isInteger(amount) || amount <= 0) {
        await msg.reply('❌ Formato: `/giveall <cantidad>`\nEjemplo: `/giveall 500`');
        return;
      }

      const others = chat.participants.filter(p => p.id._serialized !== userId);
      const total  = amount * others.length;

      if (!(await db.userExists(userId))) {
        await msg.reply('❌ Primero registrate con `/saldo`.');
        return;
      }
      const senderBalance = await db.getBalance(userId);
      if (senderBalance < total) {
        await msg.reply(
          `❌ Saldo insuficiente. Necesitás *${total.toLocaleString('es-AR')}* ` +
          `(${amount.toLocaleString('es-AR')} × ${others.length} personas) ` +
          `pero tenés *${senderBalance.toLocaleString('es-AR')} cavopoints*.`
        );
        return;
      }

      await db.updateBalance(userId, -total);
      for (const p of others) {
        const pId = p.id._serialized;
        if (await db.userExists(pId)) await db.updateBalance(pId, amount);
      }

      await chat.sendMessage(
        `🎁 *${userName}* regaló *${amount.toLocaleString('es-AR')} cavopoints* a cada miembro del grupo!\n` +
        `💸 Total entregado: *${total.toLocaleString('es-AR')} cavopoints*\n` +
        `💰 Saldo de ${userName}: ${(await db.getBalance(userId)).toLocaleString('es-AR')}`
      );
      return;
    }

    // ── /kick ─────────────────────────────────────────────────────────────────
    if (body.startsWith('/kick')) {
      const mentioned = msg.mentionedIds;
      if (!mentioned || mentioned.length === 0) {
        await msg.reply('❌ Usá: `/kick @usuario`');
        return;
      }

      // Resolver LID de Meta al número de teléfono real
      let targetId = mentioned[0];
      try {
        const targetContact = await client.getContactById(targetId);
        if (targetContact.number) targetId = targetContact.number + '@c.us';
      } catch { /* usar id original si falla */ }

      if (kickVotes.has(targetId)) {
        await msg.reply('⚠️ Ya hay una votación activa para ese usuario.');
        return;
      }

      const freshChat    = await client.getChatById(chat.id._serialized);
      const participants = freshChat.participants || [];

      const targetParticipant = participants.find(p => p.id._serialized === targetId);
      if (targetParticipant && (targetParticipant.isAdmin || targetParticipant.isSuperAdmin)) {
        await msg.reply('❌ No se puede echar a un admin.');
        return;
      }

      const totalVoters = Math.max(participants.filter(p => !p.isAdmin && !p.isSuperAdmin).length, 2);
      const needed      = Math.floor(totalVoters / 2) + 1;

      const voteMsg = await chat.sendMessage(
        `🗳️ *¿Echamos a @${targetId.split('@')[0]}?*\n\n` +
        `Reaccioná con 👍 para votar. Se necesitan *${needed} votos* (mayoría simple).\n` +
        `⏱ La votación dura *10 minutos*.`,
        { mentions: [targetId] }
      );

      kickVotes.set(targetId, {
        votes:     new Set(),
        messageId: voteMsg.id._serialized,
        chatId:    chat.id._serialized,
        needed,
        timer: setTimeout(async () => {
          kickVotes.delete(targetId);
          await chat.sendMessage('❌ Votación terminada sin mayoría. El usuario no fue echado.');
        }, 10 * 60 * 1000),
      });
      return;
    }

    // ── /spell ───────────────────────────────────────────────────────────────
    if (body.startsWith('/spell ') || body === '/spell') {
      const nombre = msg.body.trim().slice(7).trim();
      if (!nombre) {
        await msg.reply('❌ Formato: `/spell <nombre>`\nEjemplo: `/spell Bola de Fuego`');
        return;
      }

      const spell = await db.getSpell(nombre);
      if (!spell) {
        const similares = await db.searchSpells(nombre);
        if (similares.length > 0) {
          await msg.reply(`❌ No encontré *${nombre}*.\n\n¿Quisiste decir?\n${similares.map(s => `• ${s.nombre}`).join('\n')}`);
        } else {
          await msg.reply(`❌ No encontré el spell *${nombre}*.`);
        }
        return;
      }

      await msg.reply(
        `📖 *${spell.nombre}*  ·  Nivel ${spell.lvl}\n\n` +
        `⏱ *Casting Time:* ${spell.casting_time || '—'}\n` +
        `🔮 *Componentes:* ${spell.componentes || '—'}\n` +
        `🏫 *Escuela:* ${spell.escuela || '—'}\n` +
        `📏 *Rango:* ${spell.rango || '—'}\n` +
        `🛡️ *Save:* ${spell.save || '—'}\n` +
        `💥 *Daño:* ${spell.dano || '—'}\n` +
        `✨ *Efecto:* ${spell.efecto || '—'}\n` +
        `🎯 *Objetivo:* ${spell.objetivo || '—'}\n\n` +
        `📚 *Descripción:* ${spell.descripcion || '—'}\n\n` +
        `${spell.modificado_dm ? '⚠️ _Modificado por el DM_' : ''}`
      );
      return;
    }

    // ── /addspell ─────────────────────────────────────────────────────────────
    if (body === '/addspell') {
      const participant = chat.participants?.find(p => p.id._serialized === userId);
      if (!participant?.isAdmin && !participant?.isSuperAdmin) {
        await msg.reply('❌ Solo los admins pueden agregar spells.');
        return;
      }

      await msg.reply(
        '📋 *Plantilla para agregar spell:*\n\n' +
        'Copiá esto, completá cada campo y envialo:\n\n' +
        '/savespell\n' +
        'Nombre: \n' +
        'Lvl: \n' +
        'Casting Time: \n' +
        'Componentes: \n' +
        'Escuela: \n' +
        'Rango: \n' +
        'Save: \n' +
        'Daño: \n' +
        'Efecto: \n' +
        'Objetivo: \n' +
        'Descripcion Libro: \n' +
        'Modificado DM: no'
      );
      return;
    }

    // ── /savespell ────────────────────────────────────────────────────────────
    if (msg.body.trim().toLowerCase().startsWith('/savespell')) {
      const participant = chat.participants?.find(p => p.id._serialized === userId);
      if (!participant?.isAdmin && !participant?.isSuperAdmin) {
        await msg.reply('❌ Solo los admins pueden agregar spells.');
        return;
      }

      const lines = msg.body.trim().split('\n').slice(1); // saltar la línea /savespell
      const fields = {};
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim();
        if (key === 'nombre')           fields.nombre       = val;
        if (key === 'lvl')              fields.lvl          = parseInt(val) || 0;
        if (key === 'casting time')     fields.casting_time = val;
        if (key === 'componentes')      fields.componentes  = val;
        if (key === 'escuela')          fields.escuela      = val;
        if (key === 'rango')            fields.rango        = val;
        if (key === 'save')             fields.save         = val;
        if (key === 'daño' || key === 'dano') fields.dano   = val;
        if (key === 'efecto')           fields.efecto       = val;
        if (key === 'objetivo')         fields.objetivo     = val;
        if (key === 'descripcion libro' || key === 'descripción libro') fields.descripcion = val;
        if (key === 'modificado dm')    fields.modificado_dm = val.toLowerCase() === 'si' || val.toLowerCase() === 'sí';
      }

      if (!fields.nombre) {
        await msg.reply('❌ El campo *Nombre* es obligatorio.');
        return;
      }
      if (fields.lvl === undefined || fields.lvl === null) {
        await msg.reply('❌ El campo *Lvl* es obligatorio.');
        return;
      }

      await db.saveSpell(fields);
      await msg.reply(`✅ Spell *${fields.nombre}* guardado correctamente.`);
      return;
    }

    // ── /roll XdY ────────────────────────────────────────────────────────────
    if (body.startsWith('/roll ') || body === '/roll') {
      const match = body.match(/^\/roll\s+(\d+)d(\d+)$/);
      if (!match) {
        await msg.reply('❌ Formato: `/roll XdY`\nEjemplo: `/roll 2d6`');
        return;
      }

      const count = parseInt(match[1]);
      const faces = parseInt(match[2]);

      if (count < 1 || count > 20) {
        await msg.reply('❌ La cantidad de dados debe estar entre 1 y 20.');
        return;
      }
      if (faces < 2 || faces > 1000) {
        await msg.reply('❌ Las caras del dado deben estar entre 2 y 1000.');
        return;
      }

      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * faces) + 1);
      const total = rolls.reduce((a, b) => a + b, 0);
      const detail = count > 1 ? `\n🎲 Dados: ${rolls.join(', ')}` : '';

      await msg.reply(`🎲 *${userName}* tiró *${count}d${faces}*${detail}\n💥 Total: *${total}*`);
      return;
    }

    // ── /ayuda o /help ───────────────────────────────────────────────────────
    if (body === '/ayuda' || body === '/help') {
      await msg.reply(
        '🎰 *RULETA CASINO — AYUDA*\n\n' +
        '*Comandos generales:*\n' +
        '• `/saldo` — Ver tus cavopoints\n' +
        '• `/ranking` — Top 10 jugadores\n' +
        '• `/give @usuario <cantidad>` — Regalar cavopoints a otro jugador\n' +
        '• `/giveall <cantidad>` — Regalar cavopoints a todos en el grupo\n' +
        '• `/kick @usuario` — Votación para echar a alguien (mayoría simple, 2 min)\n' +
        '• `/help` — Este mensaje\n\n' +
        '*Comandos de juego (admins):*\n' +
        '• `/ruleta` — Abrir ronda de apuestas (2 minutos)\n' +
        '• `/cancelar` — Cancelar ronda y devolver apuestas\n\n' +
        '*Apostar:*\n' +
        '• `/bet <monto> <tipo>` — Una apuesta\n' +
        '• `/bet <monto> <tipo> <tipo2> ...` — Varias apuestas al mismo monto\n' +
        '  Ej: `/bet 5000 d1 d2 rojo`\n\n' +
        '*Tipos de apuesta:*\n' +
        '• `0`-`36` — Número exacto → paga *35x*\n' +
        '• `d1` `d2` `d3` — Docena → paga *2x*\n' +
        '• `c1` `c2` `c3` — Columna → paga *2x*\n' +
        '• `rojo` `negro` — Color → paga *1x*\n' +
        '• `par` `impar` — Par/Impar → paga *1x*\n' +
        '• `alto` `bajo` — Alto (19-36) / Bajo (1-18) → paga *1x*\n\n' +
        '💰 Cada viernes se regalan *20.000 cavopoints* a todos.'
      );
      return;
    }

  } catch (err) {
    console.error('Error procesando mensaje:', err);
  }
});

// ─── Comandos por terminal ────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== '/giveall') return;

  if (parts.length < 3) {
    console.log('Uso: /giveall <groupId> <cantidad>');
    return;
  }

  const groupId = parts[1];
  const amount  = parseInt(parts[2]);

  if (!Number.isInteger(amount) || amount <= 0) {
    console.log('❌ La cantidad debe ser un número positivo.');
    return;
  }

  try {
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) { console.log('❌ Ese ID no es un grupo.'); return; }

    const members = chat.participants.filter(p => p.id._serialized !== client.info?.wid?._serialized);
    for (const p of members) {
      await db.getOrCreateUser(p.id._serialized, p.id._serialized.split('@')[0]);
      await db.updateBalance(p.id._serialized, amount);
    }

    await chat.sendMessage(
      `🎁 *Regalito del admin!*\n\n` +
      `Se acreditaron *${amount.toLocaleString('es-AR')} cavopoints* a todos los miembros.`
    );
    console.log(`✅ ${amount.toLocaleString('es-AR')} cavopoints dados a ${members.length} miembros de "${chat.name}"`);
  } catch (e) {
    console.log('❌ Error:', e.message);
  }
});

// ─── Arranque ────────────────────────────────────────────────────────────────
db.init()
  .then(() => client.initialize())
  .catch(err => { console.error('❌ Error al inicializar DB:', err); process.exit(1); });
