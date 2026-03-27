const db = require('./db');

// ─── Constantes de ruleta ────────────────────────────────────────────────────
const RED_NUMBERS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
const COLUMN_1    = [1,4,7,10,13,16,19,22,25,28,31,34];
const COLUMN_2    = [2,5,8,11,14,17,20,23,26,29,32,35];
const COLUMN_3    = [3,6,9,12,15,18,21,24,27,30,33,36];

const BETTING_TIME_MS = 2 * 60 * 1000;

const PAYOUT_MAP = {
  r: 1, rojo: 1, n: 1, negro: 1,
  par: 1, impar: 1, alto: 1, bajo: 1,
  d1: 2, d2: 2, d3: 2,
  c1: 2, c2: 2, c3: 2,
};

const BET_LABELS = {
  r: 'Rojo', rojo: 'Rojo', n: 'Negro', negro: 'Negro',
  par: 'Par', impar: 'Impar',
  alto: 'Alto (19-36)', bajo: 'Bajo (1-18)',
  d1: '1ª Docena (1-12)', d2: '2ª Docena (13-24)', d3: '3ª Docena (25-36)',
  c1: 'Columna 1', c2: 'Columna 2', c3: 'Columna 3',
};

const state = {
  active: false,
  chatId: null,
  bets: new Map(),
  timer: null,
};

function getColor(n) {
  if (n === 0) return 'verde';
  return RED_NUMBERS.includes(n) ? 'rojo' : 'negro';
}

function payoutMultiplier(betType) {
  if (!isNaN(betType)) return 35;
  return PAYOUT_MAP[betType] ?? -1;
}

function isValidBet(betType) {
  if (!isNaN(betType)) {
    const n = parseInt(betType);
    return n >= 0 && n <= 36;
  }
  return betType in PAYOUT_MAP;
}

function betLabel(betType) {
  if (!isNaN(betType)) return `Número ${betType}`;
  return BET_LABELS[betType] || betType;
}

function checkWin(betType, number) {
  const color = getColor(number);
  if (!isNaN(betType)) return parseInt(betType) === number;
  switch (betType) {
    case 'r': case 'rojo':  return color === 'rojo';
    case 'n': case 'negro': return color === 'negro';
    case 'par':    return number !== 0 && number % 2 === 0;
    case 'impar':  return number !== 0 && number % 2 !== 0;
    case 'bajo':   return number >= 1 && number <= 18;
    case 'alto':   return number >= 19 && number <= 36;
    case 'd1':     return number >= 1  && number <= 12;
    case 'd2':     return number >= 13 && number <= 24;
    case 'd3':     return number >= 25 && number <= 36;
    case 'c1':     return COLUMN_1.includes(number);
    case 'c2':     return COLUMN_2.includes(number);
    case 'c3':     return COLUMN_3.includes(number);
    default:       return false;
  }
}

function fmt(n) { return n.toLocaleString('es-AR'); }

// ─── Lógica del juego ─────────────────────────────────────────────────────────
async function startGame(chat) {
  if (state.active) {
    await chat.sendMessage('⚠️ Ya hay una ruleta activa. Esperá que termine.');
    return;
  }

  state.active = true;
  state.chatId  = chat.id._serialized;
  state.bets    = new Map();

  await chat.sendMessage(
    '🎰 *¡RULETA CASINO ABIERTA!*\n\n' +
    '⏱ Tienen *2 minutos* para apostar.\n\n' +
    '*Comando:* `/bet <monto> <tipo>`\n\n' +
    '*Tipos de apuesta:*\n' +
    '• Número exacto: `/bet 1000 7`  → paga *35x*\n' +
    '• Docena: `/bet 1000 d1` | `d2` | `d3`  → paga *2x*\n' +
    '• Columna: `/bet 1000 c1` | `c2` | `c3`  → paga *2x*\n' +
    '• Color: `/bet 1000 rojo` | `negro`  → paga *1x*\n' +
    '• Par/Impar: `/bet 1000 par` | `impar`  → paga *1x*\n' +
    '• Alto/Bajo: `/bet 1000 alto` | `bajo`  → paga *1x*\n\n' +
    '💡 Podés hacer múltiples apuestas.\n' +
    '💰 Usá `/saldo` para ver tus cavopoints.'
  );

  state.timer = setTimeout(() => spinAndPay(chat), BETTING_TIME_MS);
}

async function cancelGame(chat) {
  if (!state.active || state.chatId !== chat.id._serialized) {
    await chat.sendMessage('❌ No hay una ruleta activa.');
    return;
  }

  clearTimeout(state.timer);

  for (const [userId, bets] of state.bets.entries()) {
    const total = bets.reduce((s, b) => s + b.amount, 0);
    await db.updateBalance(userId, total);
  }

  state.active = false;
  state.chatId  = null;
  state.bets    = new Map();
  state.timer   = null;

  await chat.sendMessage('🚫 Ruleta cancelada. Se devolvieron todas las apuestas.');
}

async function placeBet(chat, msg, userId, userName, amount, betType) {
  if (!state.active || state.chatId !== chat.id._serialized) {
    await msg.reply('❌ No hay una ruleta activa. Un admin debe iniciar con `/ruleta`.');
    return;
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    await msg.reply('❌ El monto debe ser un número entero positivo.\nEjemplo: `/bet 4000 d1`');
    return;
  }

  if (!isValidBet(betType)) {
    await msg.reply(
      '❌ Tipo de apuesta inválido.\n' +
      'Opciones: número (0-36), rojo, negro, par, impar, alto, bajo, d1, d2, d3, c1, c2, c3'
    );
    return;
  }

  const balance = await db.getBalance(userId);
  if (balance === 0 && !(await db.userExists(userId))) {
    await msg.reply('❌ Primero registrate con `/saldo`.');
    return;
  }

  if (balance < amount) {
    await msg.reply(`❌ Saldo insuficiente. Tu saldo: *${fmt(balance)} cavopoints*`);
    return;
  }

  await db.updateBalance(userId, -amount);

  if (!state.bets.has(userId)) state.bets.set(userId, []);
  state.bets.get(userId).push({ amount, betType, userName });

  const newBalance = await db.getBalance(userId);
  const mult       = payoutMultiplier(betType);

  await msg.reply(
    `✅ Apuesta registrada!\n` +
    `📊 *${fmt(amount)}* cavopoints → *${betLabel(betType)}* (paga ${mult}x)\n` +
    `💰 Saldo restante: *${fmt(newBalance)} cavopoints*`
  );
}

async function spinAndPay(chat) {
  const number = Math.floor(Math.random() * 37);
  const color  = getColor(number);
  const colorEmoji = { rojo: '🔴', negro: '⚫', verde: '🟢' }[color];

  await chat.sendMessage(
    '🎰 *¡GIRANDO LA RULETA!*\n\n' +
    '🔄 ⚫🔴⚫🔴⚫🔴⚫🔴⚫ 🔄\n\n' +
    '⏳ Calculando resultado...'
  );

  await new Promise(r => setTimeout(r, 2500));

  let resultHeader = `${colorEmoji} *NÚMERO: ${number}*  |  ${color.toUpperCase()}\n`;
  if (number !== 0) {
    resultHeader +=
      `${number % 2 === 0 ? 'PAR' : 'IMPAR'}  •  ` +
      `${number >= 1 && number <= 18 ? 'BAJO (1-18)' : 'ALTO (19-36)'}  •  ` +
      `${number >= 1 && number <= 12 ? 'D1' : number <= 24 ? 'D2' : 'D3'}\n`;
  }

  await chat.sendMessage(`🎯 *RESULTADO*\n\n${resultHeader}`);

  if (state.bets.size === 0) {
    await chat.sendMessage('😔 Nadie apostó esta ronda.');
    resetState();
    return;
  }

  const roundId = await db.createRound(number, color);
  const lines   = [];
  let totalPaid = 0;

  for (const [userId, bets] of state.bets.entries()) {
    const name = bets[0].userName;
    let returned = 0;

    for (const bet of bets) {
      const won    = checkWin(bet.betType, number);
      const mult   = payoutMultiplier(bet.betType);
      const payout = won ? bet.amount + bet.amount * mult : 0;
      if (won) returned += payout;
      await db.saveBet(roundId, userId, bet.amount, bet.betType, won, payout);
    }

    if (returned > 0) {
      await db.updateBalance(userId, returned);
      totalPaid += returned;
      lines.push(`✅ *${name}*: ganó *+${fmt(returned)}* → saldo: ${fmt(await db.getBalance(userId))}`);
    } else {
      lines.push(`❌ *${name}*: sin suerte → saldo: ${fmt(await db.getBalance(userId))}`);
    }
  }

  await db.closeRound(roundId);

  await chat.sendMessage(
    `🏆 *RESULTADOS:*\n\n` +
    lines.join('\n') +
    `\n\n💸 Total pagado: *${fmt(totalPaid)} cavopoints*`
  );

  resetState();
}

function resetState() {
  state.active = false;
  state.chatId  = null;
  state.bets    = new Map();
  state.timer   = null;
}

function isActive(chatId) {
  return state.active && state.chatId === chatId;
}

module.exports = { startGame, cancelGame, placeBet, isActive };
