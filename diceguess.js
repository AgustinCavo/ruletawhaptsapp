const db = require('./db');

const BETTING_TIME_MS = 2 * 60 * 1000;

const state = {
  active: false,
  chatId:  null,
  // userId -> { guess, amount, userName }
  guesses: new Map(),
  timer:   null,
};

function fmt(n) { return n.toLocaleString('es-AR'); }

function isActive(chatId) {
  return state.active && state.chatId === chatId;
}

async function startGame(chat) {
  if (state.active) {
    await chat.sendMessage('⚠️ Ya hay un DiceGuess activo. Esperá que termine.');
    return;
  }

  state.active  = true;
  state.chatId  = chat.id._serialized;
  state.guesses = new Map();

  await chat.sendMessage(
    '🎲 *¡DICEGUESS ABIERTO!*\n\n' +
    'Se tirará un dado de *100 caras*. ¡Adiviná el número!\n\n' +
    '*Comando:* `/guess <número> <apuesta>`\n' +
    '• Número: del *1 al 100*\n' +
    '• El más cercano al resultado se lleva *todo el pozo*\n' +
    '• Empate → se divide entre los que eligieron el mismo número\n\n' +
    '⏱ Tienen *2 minutos* para apostar.\n' +
    '💰 Usá `/saldo` para ver tus cavopoints.'
  );

  state.timer = setTimeout(() => rollAndPay(chat), BETTING_TIME_MS);
}

async function cancelGame(chat) {
  if (!state.active || state.chatId !== chat.id._serialized) {
    await chat.sendMessage('❌ No hay un DiceGuess activo.');
    return;
  }

  clearTimeout(state.timer);

  for (const [userId, entry] of state.guesses.entries()) {
    await db.updateBalance(userId, entry.amount);
  }

  state.active  = false;
  state.chatId  = null;
  state.guesses = new Map();
  state.timer   = null;

  await chat.sendMessage('🚫 DiceGuess cancelado. Se devolvieron todas las apuestas.');
}

async function placeGuess(chat, msg, userId, userName, guess, amount) {
  if (!state.active || state.chatId !== chat.id._serialized) {
    await msg.reply('❌ No hay un DiceGuess activo. Un admin debe iniciar con `/diceguess`.');
    return;
  }

  if (!Number.isInteger(guess) || guess < 1 || guess > 100) {
    await msg.reply('❌ El número debe estar entre *1 y 100*.');
    return;
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    await msg.reply('❌ La apuesta debe ser un número positivo.');
    return;
  }

  if (!(await db.userExists(userId))) {
    await msg.reply('❌ Primero registrate con `/saldo`.');
    return;
  }

  // Si ya apostó, devolver apuesta anterior
  if (state.guesses.has(userId)) {
    const prev = state.guesses.get(userId);
    await db.updateBalance(userId, prev.amount);
  }

  const balance = await db.getBalance(userId);
  if (balance < amount) {
    await msg.reply(`❌ Saldo insuficiente. Tu saldo: *${fmt(balance)} cavopoints*`);
    return;
  }

  await db.updateBalance(userId, -amount);
  state.guesses.set(userId, { guess, amount, userName });

  const newBalance = await db.getBalance(userId);
  await msg.reply(
    `✅ *${userName}* apostó *${fmt(amount)}* cavopoints al número *${guess}*\n` +
    `💰 Saldo restante: *${fmt(newBalance)} cavopoints*`
  );
}

async function rollAndPay(chat) {
  const result = Math.floor(Math.random() * 100) + 1;

  await chat.sendMessage(
    '🎲 *¡TIRANDO EL DADO!*\n\n' +
    '🔄 1 · 2 · 3 · ... · 98 · 99 · 100 🔄\n\n' +
    '⏳ Calculando resultado...'
  );

  await new Promise(r => setTimeout(r, 2500));

  await chat.sendMessage(`🎯 *RESULTADO: ${result}*`);

  if (state.guesses.size === 0) {
    await chat.sendMessage('😔 Nadie apostó esta ronda.');
    resetState();
    return;
  }

  // Encontrar distancia mínima
  const minDist = Math.min(...[...state.guesses.values()].map(e => Math.abs(e.guess - result)));

  // Números ganadores distintos (puede haber empate entre distintos números)
  const winningNumbers = [...new Set(
    [...state.guesses.values()]
      .filter(e => Math.abs(e.guess - result) === minDist)
      .map(e => e.guess)
  )];

  const pot   = [...state.guesses.values()].reduce((s, e) => s + e.amount, 0);
  const lines = [];

  // Empate entre distintos números → todos pierden, el pozo se quema
  if (winningNumbers.length > 1) {
    for (const [, entry] of state.guesses.entries()) {
      lines.push(`❌ *${entry.userName}* eligió ${entry.guess}`);
    }
    await chat.sendMessage(
      `🎲 *RESULTADOS DICEGUESS* (salió el *${result}*)\n\n` +
      `⚡ *¡EMPATE!* Los números *${winningNumbers.join(' y ')}* quedaron igual de cerca.\n` +
      `💸 El pozo de *${fmt(pot)} cavopoints* se quema. ¡Todos pierden!\n\n` +
      lines.join('\n')
    );
    resetState();
    return;
  }

  // Un solo número ganador (puede tener varios jugadores → se dividen)
  const winners = [...state.guesses.entries()].filter(([, e]) => e.guess === winningNumbers[0]);

  const winnerIds = new Set(winners.map(([id]) => id));
  for (const [uid, entry] of state.guesses.entries()) {
    if (!winnerIds.has(uid)) {
      lines.push(`❌ *${entry.userName}* eligió ${entry.guess} → sin suerte`);
    }
  }

  const share = Math.floor(pot / winners.length);
  for (const [wId, wEntry] of winners) {
    await db.updateBalance(wId, share);
    const bal = await db.getBalance(wId);
    lines.push(
      `🏆 *${wEntry.userName}* eligió *${wEntry.guess}* ` +
      `(distancia: ${minDist}) → ganó *+${fmt(share)}* → saldo: ${fmt(bal)}`
    );
  }

  await chat.sendMessage(
    `🎲 *RESULTADOS DICEGUESS* (salió el *${result}*)\n\n` +
    lines.join('\n') +
    `\n\n💸 Pozo total: *${fmt(pot)} cavopoints*`
  );

  resetState();
}

function resetState() {
  state.active  = false;
  state.chatId  = null;
  state.guesses = new Map();
  state.timer   = null;
}

module.exports = { startGame, cancelGame, placeGuess, isActive };
