// Пивнушка: a match-3 with levels. A level is a board shape, plates under some cells, pieces that are locked,
// frozen or boxed, and a number of swaps. The level is won when every plate is broken.
// The same seed always deals the same pieces and the same refills, so a finished game can be played again
// from its seed, its level and its list of actions, and gives the same result.
//
// Cells are numbered row by row from the top left: i = row * COLS + col.
// A cell holds VOID (not a part of the board) or a piece: base + 32 * cover.
//   base:  kind + KINDS * type (kind 0..KINDS-1, type 0 plain, LINE_H, LINE_V or BOMB), GOLD or CRATE
//   cover: 0 none, LOCK, ICE or ICE2

export const COLS = 7, ROWS = 8;
export const SIZE = COLS * ROWS;
export const KINDS = 6;
export const MIN_MOVE_MS = 500;       // a game may not go faster than this per swap
export const COIN_DIV = 20;           // points for one coin
export const MAX_PAY = 500;           // the most coins one game pays

// Special pieces. A run of 4 leaves a line piece, two crossing runs a bomb, a run of 5 a golden one.
export const LINE_H = 1;              // clears its row
export const LINE_V = 2;              // clears its column
export const BOMB = 3;                // clears 3×3 around it
export const GOLD = KINDS * 4;        // swapped with a piece, clears every piece of that kind
export const CRATE = GOLD + 1;        // a box: no kind, cannot be swapped, breaks when a run is made next to it
export const VOID = -1;
const HOLE = -2;                      // a cell just emptied, before the pieces fall

// Covers. A covered piece cannot be swapped.
export const LOCK = 1;                // chained: still counts in runs; a run or a blast takes the chain off
export const ICE = 2;                 // frozen: counts in no run; a run next to it or a blast melts it
export const ICE2 = 3;                // thick ice: the first hit leaves ICE

export const baseOf = v => v & 31;
export const coverOf = v => v >> 5;
// The kind a piece matches by, -1 if it matches nothing
export const kindOf = v => (v < 0 || (v & 31) >= GOLD || v >> 5 >= ICE ? -1 : (v & 31) % KINDS);
export const typeOf = v => ((v & 31) === GOLD ? 4 : (v & 31) === CRATE ? 0 : Math.floor((v & 31) / KINDS));
const isSpecial = v => v >= 0 && (v & 31) >= KINDS && (v & 31) <= GOLD;
const movable = v => v >= 0 && v >> 5 === 0 && (v & 31) !== CRATE;

// Boosters, bought during a game: how many of each a game may use, and what one costs in coins.
// "h" hits one cell, "s" mixes the board, "m" adds BOOST_MOVES swaps.
export const MAX_BOOST = 3;
export const BOOST_MOVES = 5;
export const BOOSTS = { h: 60, s: 20, m: 100 };

const RUN_PTS = [0, 0, 0, 30, 60, 100]; // points for a run of 3, 4, 5; longer ones add RUN_MORE per piece
const RUN_MORE = 50;
const BLAST_PTS = 20;                 // a piece cleared by a special piece or a booster, not by a run
const COVER_PTS = 20;                 // a chain taken off, a layer of ice melted
const PLATE_PTS = 30;                 // a plate (or one layer of a double one) broken
export const LEFT_PTS = 100;          // every swap left when the level is won

// Seeded random 0..1 (mulberry32)
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- levels ---------- */

// Board shapes, 8 rows of 7: "X" is a cell, "." is not a part of the board
const SHAPES = [
  ["XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX"],
  [".XXXXX.", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", ".XXXXX."],
  ["XXXXXXX", "XXXXXXX", "XXXXXXX", "XXX.XXX", "XXX.XXX", "XXXXXXX", "XXXXXXX", "XXXXXXX"],
  ["..XXX..", ".XXXXX.", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX.."],
  ["XXXXXXX", "XXXXXXX", ".XXXXX.", ".XXXXX.", ".XXXXX.", ".XXXXX.", "XXXXXXX", "XXXXXXX"],
  ["X.XXX.X", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "X.XXX.X"],
  ["..XXX..", "..XXX..", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "..XXX..", "..XXX.."],
  ["XXXXXXX", "X.XXX.X", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "X.XXX.X", "XXXXXXX"],
  [".XXXXX.", ".XXXXX.", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", ".XXXXX."],
  ["XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX.."],
  ["...X...", "..XXX..", ".XXXXX.", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX"],
  ["XXXXXXX", "XX.X.XX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XX.X.XX", "XXXXXXX"],
];

const lerp = (a, b, k) => a + (b - a) * k;
const mirror = i => Math.floor(i / COLS) * COLS + (COLS - 1 - (i % COLS));

// Level n (from 1), always the same for the same n:
// { n, cells: [cell numbers of the board], plates: layers of plate under each cell (0, 1 or 2),
//   locks, ice, ice2, crates: [cells], moves: swaps given, prize: coins for winning on top of the score }
export function levelOf(n) {
  n = Math.max(1, Math.floor(n) || 1);
  const r = rng(Math.imul(n, 0x9e3779b1) ^ 0x51ed27);
  const shapeNo = (n - 1 + Math.floor((n - 1) / SHAPES.length) * 5) % SHAPES.length;
  const shape = SHAPES[shapeNo];
  const cells = [];
  for (let i = 0; i < SIZE; i++) if (shape[Math.floor(i / COLS)][i % COLS] === "X") cells.push(i);

  // The cells in a random order, each followed by its mirror: what is laid out looks even on both sides
  const order = () => {
    const pool = cells.slice(), out = [];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const seen = new Set();
    for (const c of pool) for (const x of [c, mirror(c)]) if (!seen.has(x)) { seen.add(x); out.push(x); }
    return out;
  };

  // Plates go only under cells where runs are easy to make: at least EASY_RUNS ways to lay a run of 3 over the cell.
  // Under 30% of the cells on level 1, under 55% from level 26; double ones from level 15, up to a fifth of them.
  const has = new Set(cells);
  const ways = c => {
    let count = 0;
    for (const step of [1, COLS]) {
      for (let k = -2; k <= 0; k++) {
        const run = [c + k * step, c + (k + 1) * step, c + (k + 2) * step];
        if (run.every(x => has.has(x)) && (step === COLS || Math.floor(run[0] / COLS) === Math.floor(run[2] / COLS))) count++;
      }
    }
    return count;
  };
  const plates = new Array(SIZE).fill(0);
  const plated = order().filter(c => ways(c) >= EASY_RUNS).slice(0, Math.round(cells.length * lerp(0.3, 0.55, Math.min(1, (n - 1) / 25))));
  for (const c of plated) plates[c] = 1;
  if (n >= 15) {
    const twice = Math.round(plated.length * Math.min(0.2, (n - 12) / 60));
    for (const c of order().filter(x => plates[x]).slice(0, twice)) plates[c] = 2;
  }

  // Chains from level 3, ice from level 6 (thick from level 15), boxes from level 10: more of each as n grows
  const spots = order();
  const take = count => spots.splice(0, Math.max(0, count));
  const locks = take(n >= 3 ? Math.min(6, 1 + Math.floor(n / 5)) : 0);
  const frozen = take(n >= 6 ? Math.min(5, Math.floor(n / 6)) : 0);
  const thick = n >= 15 ? Math.min(frozen.length, Math.floor((n - 9) / 6)) : 0;
  const ice2 = frozen.slice(0, thick), ice = frozen.slice(thick);
  const crates = take(n >= 10 ? Math.min(4, Math.floor((n - 5) / 5)) : 0);

  const layers = plates.reduce((a, b) => a + b, 0);
  const work = MOVES_BASE + MOVES_PLATE * layers + MOVES_BLOCK * (locks.length + ice.length + 2 * ice2.length + crates.length);
  const moves = Math.max(MOVES_MIN, Math.min(MOVES_MAX, Math.round(work * SHAPE_HARD[shapeNo])));
  return { n, cells, plates, locks, ice, ice2, crates, moves, prize: Math.min(150, 20 + 5 * n) };
}
// Swaps a level gives: a base, and more for every layer of plate and every chain, layer of ice and box,
// times how hard its shape is (measured: a careful player then wins about two games of three)
const MOVES_BASE = 11, MOVES_PLATE = 0.66, MOVES_BLOCK = 0.66, MOVES_MIN = 12, MOVES_MAX = 50;
const SHAPE_HARD = [1.05, 0.95, 1.25, 0.65, 1.05, 1, 0.65, 1.35, 0.95, 1, 0.85, 1];
const EASY_RUNS = 4;                  // of 6 ways to lay a run of 3 over a cell, how many must fit the board for a plate

/* ---------- the board ---------- */

const runPts = len => (len < RUN_PTS.length ? RUN_PTS[len] : RUN_PTS[RUN_PTS.length - 1] + (len - RUN_PTS.length + 1) * RUN_MORE);

// Every run of 3 or more pieces of one kind in a row or a column: [{ cells: [cell numbers], h: is it a row }]
export function findRuns(b) {
  const runs = [];
  const line = (start, step, count, h) => {
    let from = 0;
    for (let k = 1; k <= count; k++) {
      const kind = kindOf(b[start + from * step]);
      if (k < count && kind >= 0 && kindOf(b[start + k * step]) === kind) continue;
      if (kind >= 0 && k - from >= 3) {
        const cells = [];
        for (let j = from; j < k; j++) cells.push(start + j * step);
        runs.push({ cells, h });
      }
      from = k;
    }
  };
  for (let r = 0; r < ROWS; r++) line(r * COLS, 1, COLS, true);
  for (let c = 0; c < COLS; c++) line(c, COLS, ROWS, false);
  return runs;
}

const inBoard = i => Number.isInteger(i) && i >= 0 && i < SIZE;

// Are the two cells side by side or one above the other?
export function adjacent(a, b) {
  if (!inBoard(a) || !inBoard(b)) return false;
  const d = Math.abs(a - b);
  return d === COLS || (d === 1 && Math.floor(a / COLS) === Math.floor(b / COLS));
}
function neighbours(i) {
  const out = [], col = i % COLS;
  if (i >= COLS) out.push(i - COLS);
  if (i + COLS < SIZE) out.push(i + COLS);
  if (col > 0) out.push(i - 1);
  if (col < COLS - 1) out.push(i + 1);
  return out;
}

// May the two cells be swapped? Both pieces must be free to move. A golden piece goes with any neighbour,
// two special pieces with each other, the rest only if the swap makes a run.
export function canSwap(b, x, y) {
  if (!adjacent(x, y) || !movable(b[x]) || !movable(b[y])) return false;
  if (b[x] === GOLD || b[y] === GOLD) return true;
  if (isSpecial(b[x]) && isSpecial(b[y])) return true;
  if (kindOf(b[x]) === kindOf(b[y])) return false;
  [b[x], b[y]] = [b[y], b[x]];
  const ok = findRuns(b).length > 0;
  [b[x], b[y]] = [b[y], b[x]];
  return ok;
}

// Any allowed swap, as [from, to], or null if the board is stuck
export function findMove(b) {
  for (let i = 0; i < SIZE; i++) {
    if (i % COLS < COLS - 1 && canSwap(b, i, i + 1)) return [i, i + 1];
    if (i + COLS < SIZE && canSwap(b, i, i + COLS)) return [i, i + COLS];
  }
  return null;
}

// A kind for cell i that makes no run with the two pieces to its left or the two above it
function calmKind(b, i, r) {
  for (;;) {
    const k = Math.floor(r() * KINDS);
    if (i % COLS >= 2 && kindOf(b[i - 1]) === k && kindOf(b[i - 2]) === k) continue;
    if (i >= 2 * COLS && kindOf(b[i - COLS]) === k && kindOf(b[i - 2 * COLS]) === k) continue;
    return k;
  }
}

// The level's board: plain pieces with no runs, its chains, ice and boxes on them, and at least one move
function deal(r, level) {
  for (;;) {
    const b = new Array(SIZE).fill(VOID);
    for (const i of level.cells) b[i] = calmKind(b, i, r);
    for (const i of level.locks) b[i] += 32 * LOCK;
    for (const i of level.ice) b[i] += 32 * ICE;
    for (const i of level.ice2) b[i] += 32 * ICE2;
    for (const i of level.crates) b[i] = CRATE;
    if (!findRuns(b).length && findMove(b)) return b;
  }
}

// The pieces free to move are mixed among themselves until the board has a move and no runs. If that fails,
// they are dealt anew as plain ones. Returns false if even that leaves no move.
function shuffle(b, r) {
  const free = [];
  for (let i = 0; i < SIZE; i++) if (movable(b[i])) free.push(i);
  const calm = () => !findRuns(b).length && findMove(b);
  for (let n = 0; n < 20; n++) {
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [b[free[i]], b[free[j]]] = [b[free[j]], b[free[i]]];
    }
    if (calm()) return true;
  }
  for (let n = 0; n < 50; n++) {
    for (const i of free) b[i] = Math.floor(r() * KINDS);
    if (calm()) return true;
  }
  return false;
}

// A new game of level n: { level, board, plate: layers left under each cell, platesLeft: all layers left,
// score, left: swaps left, won } and its random source
export function newGame(seed, n = 1) {
  const r = rng(seed), level = levelOf(n);
  const plate = level.plates.slice();
  return { r, level, board: deal(r, level), plate, platesLeft: plate.reduce((a, b) => a + b, 0), score: 0, left: level.moves, won: false };
}

// The kind most pieces outside gone have; the lowest one if several do, -1 if none is left
function commonKind(b, gone) {
  const count = new Array(KINDS).fill(0);
  for (let i = 0; i < SIZE; i++) if (!gone.has(i) && kindOf(b[i]) >= 0) count[kindOf(b[i])]++;
  const most = Math.max(...count);
  return most ? count.indexOf(most) : -1;
}

// Clears runs round after round until the board is calm. first(add, skip), if given, starts the first round:
// add(cell) hits a cell, skip is the set of cells whose special piece must not go off by itself.
// hot are the swapped cells: a special piece made in the first round appears there.
// A hit takes a cover off a covered piece (a layer of thick ice) and leaves the piece; any other piece goes,
// and a layer of the plate under it with it. Ice and boxes next to a run are hit too.
// Returns the rounds: [{ cleared: [cells], changed: [[cell, piece]], made: [[cell, piece]], plates: [[cell, layers]],
//   fx: [[type, cell]], gain, combo, board, drops }].
// cleared are the pieces gone, changed the pieces that lost a cover, made the special pieces that appeared,
// plates the plates hit and what is left of them, fx the special pieces that went off, board the board after
// the pieces fell and new ones came, drops[i] how many rows the piece now in cell i fell (a new one comes
// from above the top: its drop is more than its row).
function resolve(g, first = null, hot = []) {
  const b = g.board, steps = [];
  for (let combo = 1; ; combo++) {
    const runs = findRuns(b);
    if (!runs.length && !(combo === 1 && first)) break;

    const hit = new Set(), skip = new Set(), queue = [], fx = [];
    const add = i => { if (b[i] !== VOID && !hit.has(i)) { hit.add(i); queue.push(i); } };

    // What the runs leave behind: a golden piece for 5 in a line, a bomb where two runs cross, a line piece for 4.
    // It appears in a cell of the run that has no cover.
    const made = new Map(), used = new Set();
    const spot = run => {
      const order = [run.cells[run.cells.length >> 1], ...run.cells];
      if (combo === 1) order.unshift(...run.cells.filter(c => hot.includes(c)));
      return order.find(c => !made.has(c) && coverOf(b[c]) === 0);
    };
    runs.forEach((run, n) => {
      if (run.cells.length < 5) return;
      const c = spot(run);
      if (c !== undefined) { made.set(c, GOLD); used.add(n); }
    });
    for (let n = 0; n < runs.length; n++) {
      for (let m = n + 1; m < runs.length; m++) {
        if (used.has(n) || used.has(m) || runs[n].h === runs[m].h) continue;
        const c = runs[n].cells.find(x => runs[m].cells.includes(x));
        if (c === undefined || made.has(c) || coverOf(b[c]) !== 0) continue;
        made.set(c, kindOf(b[c]) + KINDS * BOMB);
        used.add(n); used.add(m);
      }
    }
    runs.forEach((run, n) => {
      if (used.has(n) || run.cells.length !== 4) return;
      const c = spot(run);
      if (c !== undefined) made.set(c, kindOf(b[c]) + KINDS * (run.h ? LINE_H : LINE_V));
    });

    let pts = 0;
    for (const run of runs) {
      pts += runPts(run.cells.length);
      for (const c of run.cells) add(c);
    }
    const inRuns = new Set(hit);
    if (combo === 1 && first) first(add, skip);

    // Special pieces among the hit ones go off and hit more; a covered one only loses its cover
    while (queue.length) {
      const i = queue.shift(), v = b[i];
      if (!isSpecial(v) || coverOf(v) !== 0 || skip.has(i)) continue;
      const col = i % COLS, row = Math.floor(i / COLS), t = typeOf(v);
      fx.push([t, i]);
      if (t === LINE_H) for (let c = 0; c < COLS; c++) add(row * COLS + c);
      else if (t === LINE_V) for (let r = 0; r < ROWS; r++) add(r * COLS + col);
      else if (t === BOMB) {
        for (let r = Math.max(0, row - 1); r <= Math.min(ROWS - 1, row + 1); r++)
          for (let c = Math.max(0, col - 1); c <= Math.min(COLS - 1, col + 1); c++) add(r * COLS + c);
      } else {
        const kind = commonKind(b, hit);
        for (let j = 0; j < SIZE; j++) if (kind >= 0 && kindOf(b[j]) === kind) add(j);
      }
    }
    // Ice and boxes next to a run
    for (const c of inRuns) {
      for (const nb of neighbours(c)) if (b[nb] >= 0 && (coverOf(b[nb]) >= ICE || baseOf(b[nb]) === CRATE)) hit.add(nb);
    }

    // The hits land
    const cleared = [], changed = [], plates = [];
    for (const i of hit) {
      const v = b[i], cover = coverOf(v);
      if (cover) {
        b[i] = baseOf(v) + (cover === ICE2 ? 32 * ICE : 0);
        changed.push([i, b[i]]);
        pts += COVER_PTS;
        continue;
      }
      b[i] = HOLE;
      cleared.push(i);
      if (!inRuns.has(i)) pts += BLAST_PTS;
      if (g.plate[i]) {
        g.plate[i]--; g.platesLeft--;
        plates.push([i, g.plate[i]]);
        pts += PLATE_PTS;
      }
    }
    for (const [c, v] of made) b[c] = v;
    const gain = pts * combo;
    g.score += gain;

    // The pieces fall down their columns, past the cells that are not a part of the board; new ones come from above
    const drops = new Array(SIZE).fill(0);
    for (let c = 0; c < COLS; c++) {
      const rows = [];
      for (let row = 0; row < ROWS; row++) if (b[row * COLS + c] !== VOID) rows.push(row);
      let to = rows.length - 1;
      for (let k = rows.length - 1; k >= 0; k--) {
        const i = rows[k] * COLS + c;
        if (b[i] === HOLE) continue;
        if (to !== k) { b[rows[to] * COLS + c] = b[i]; drops[rows[to] * COLS + c] = rows[to] - rows[k]; }
        to--;
      }
      for (let k = to, n = 1; k >= 0; k--, n++) {
        b[rows[k] * COLS + c] = Math.floor(g.r() * KINDS);
        drops[rows[k] * COLS + c] = rows[k] + n;
      }
    }
    steps.push({ cleared, changed, made: [...made], plates, fx, gain, combo, board: b.slice(), drops });
  }
  return steps;
}

// What an action gives back: { steps, shuffled, won, bonus, stuck }.
// The level is won when no plate is left: every swap left then adds LEFT_PTS (bonus is their sum).
// Otherwise, if no move is left, the board is mixed (shuffled is the new board); if even that gives no move,
// the game is over (stuck).
function settle(g, steps) {
  const out = { steps, shuffled: null, won: false, bonus: 0, stuck: false };
  if (g.platesLeft <= 0) {
    out.won = g.won = true;
    out.bonus = g.left * LEFT_PTS;
    g.score += out.bonus;
  } else if (!findMove(g.board)) {
    if (shuffle(g.board, g.r)) out.shuffled = g.board.slice();
    else { out.stuck = true; g.left = 0; }
  }
  return out;
}

// One swap. Returns null if it is not allowed, otherwise what settle gives.
export function play(g, x, y) {
  if (g.won || g.left <= 0 || !canSwap(g.board, x, y)) return null;
  const b = g.board;
  const goldX = b[x] === GOLD, goldY = b[y] === GOLD;
  let first = null;
  if (goldX && goldY) {
    // Two golden pieces hit the whole board
    first = add => { for (let i = 0; i < SIZE; i++) add(i); };
  } else if (goldX || goldY) {
    // A golden piece hits every piece of its neighbour's kind
    const gold = goldX ? x : y, kind = kindOf(b[goldX ? y : x]);
    first = (add, skip) => {
      skip.add(gold); add(gold);
      for (let i = 0; i < SIZE; i++) if (kindOf(b[i]) === kind) add(i);
    };
  } else {
    const both = isSpecial(b[x]) && isSpecial(b[y]);
    [b[x], b[y]] = [b[y], b[x]];
    // Two special pieces go off together
    if (both) first = add => { add(x); add(y); };
  }
  g.left--;
  return settle(g, resolve(g, first, [x, y]));
}

// Boosters. Each returns what settle gives, or null if it cannot be used.
const hammer = (g, cell) => (inBoard(cell) && g.board[cell] !== VOID ? settle(g, resolve(g, add => add(cell))) : null);
function mix(g) {
  const out = { steps: [], shuffled: null, won: false, bonus: 0, stuck: false };
  if (shuffle(g.board, g.r)) out.shuffled = g.board.slice();
  return out;
}
function moreMoves(g) {
  g.left += BOOST_MOVES;
  return { steps: [], shuffled: null, won: false, bonus: 0, stuck: false };
}

// One action of a game: a swap [from, to], or a booster: ["h", cell], ["s"], ["m"].
// Returns what settle gives, or null if it is not allowed. A game that is won or has no swaps left takes no actions.
export function act(g, a) {
  if (!Array.isArray(a) || g.won || g.left <= 0) return null;
  if (a[0] === "h") return a.length === 2 ? hammer(g, a[1]) : null;
  if (a[0] === "s") return a.length === 1 ? mix(g) : null;
  if (a[0] === "m") return a.length === 1 ? moreMoves(g) : null;
  return a.length === 2 ? play(g, a[0], a[1]) : null;
}

// Plays a reported game of level n again. actions is the list of its actions, ms how long the game took,
// bought how many boosters of each kind were paid for: { h, s, m }.
// Returns { score, won } or { error: what is wrong }.
export function checkGame(seed, n, actions, ms, bought = {}) {
  const g = newGame(seed, n);
  const most = g.level.moves + MAX_BOOST * (BOOST_MOVES + Object.keys(BOOSTS).length);
  if (!Array.isArray(actions) || actions.length > most) return { error: "actions" };
  const usedBoosts = { h: 0, s: 0, m: 0 };
  let swaps = 0;
  for (const a of actions) {
    const boost = Array.isArray(a) && Object.hasOwn(usedBoosts, a[0]) ? a[0] : null;
    if (boost && ++usedBoosts[boost] > Math.min(MAX_BOOST, bought[boost] || 0)) return { error: "booster" };
    if (!boost) swaps++;
    if (!act(g, a)) return { error: "action" };
  }
  if (!Number.isFinite(ms) || ms < swaps * MIN_MOVE_MS) return { error: "too fast" };
  return { score: g.score, won: g.won };
}

// Coins for a won game of level n: the score's worth and the level's prize, at most MAX_PAY
export const payOf = (score, n) => Math.min(MAX_PAY, Math.floor(score / COIN_DIV) + levelOf(n).prize);
