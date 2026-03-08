// goban.js -- Collaborative Go (Weiqi/Baduk) board widget
// Supports 9x9, 13x13, 19x19 boards, capture, ko, scoring, resign, and rengo

import { WidgetBase, registerWidget } from './widget-api.js';
import state from '../state.js';

const BLACK = 1, WHITE = 2;
const EMPTY = 0;
const BOARD_SIZES = [9, 13, 19];

// Star point positions for each board size
const STAR_POINTS = {
  9:  [[2,2],[2,6],[6,2],[6,6],[4,4]],
  13: [[3,3],[3,9],[9,3],[9,9],[6,6],[3,6],[9,6],[6,3],[6,9]],
  19: [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]],
};

// ── Go game engine ──

function createBoard(size) {
  const b = [];
  for (let i = 0; i < size; i++) {
    b.push(new Array(size).fill(EMPTY));
  }
  return b;
}

function copyBoard(b) {
  return b.map(r => r.slice());
}

function boardKey(board) {
  return board.map(r => r.join('')).join('');
}

function inBounds(x, y, size) {
  return x >= 0 && x < size && y >= 0 && y < size;
}

function getGroup(board, x, y, size) {
  const color = board[y][x];
  if (color === EMPTY) return { stones: [], liberties: new Set() };
  const visited = new Set();
  const stones = [];
  const liberties = new Set();
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    const key = cy * size + cx;
    if (visited.has(key)) continue;
    visited.add(key);
    stones.push([cx, cy]);
    for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!inBounds(nx, ny, size)) continue;
      if (board[ny][nx] === EMPTY) {
        liberties.add(ny * size + nx);
      } else if (board[ny][nx] === color && !visited.has(ny * size + nx)) {
        stack.push([nx, ny]);
      }
    }
  }
  return { stones, liberties };
}

function opponent(color) {
  return color === BLACK ? WHITE : BLACK;
}

/** Try to place a stone. Returns { board, captured, koPoint } or null if illegal. */
function tryMove(board, x, y, color, size, koPoint) {
  if (board[y][x] !== EMPTY) return null;
  if (koPoint && koPoint[0] === x && koPoint[1] === y) return null;

  const newBoard = copyBoard(board);
  newBoard[y][x] = color;

  // Capture opponent groups with no liberties
  let captured = [];
  const opp = opponent(color);
  for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
    const nx = x + dx, ny = y + dy;
    if (!inBounds(nx, ny, size)) continue;
    if (newBoard[ny][nx] === opp) {
      const group = getGroup(newBoard, nx, ny, size);
      if (group.liberties.size === 0) {
        for (const [gx, gy] of group.stones) {
          newBoard[gy][gx] = EMPTY;
          captured.push([gx, gy]);
        }
      }
    }
  }

  // Check self-capture (suicide) — illegal
  const selfGroup = getGroup(newBoard, x, y, size);
  if (selfGroup.liberties.size === 0) return null;

  // Determine new ko point
  let newKo = null;
  if (captured.length === 1) {
    // Check if this is a ko: single capture, and the placed stone has exactly one liberty
    // which is the captured stone's position
    if (selfGroup.stones.length === 1 && selfGroup.liberties.size === 1) {
      newKo = [captured[0][0], captured[0][1]];
    }
  }

  return { board: newBoard, captured, koPoint: newKo };
}

// ── Scoring (Chinese-style area scoring) ──

function floodFillTerritory(board, size) {
  // Returns a 2D array: EMPTY=neutral, BLACK=black territory, WHITE=white territory
  const territory = createBoard(size);
  const visited = new Set();

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (board[y][x] !== EMPTY || visited.has(y * size + x)) continue;
      // Flood fill this empty region
      const region = [];
      const stack = [[x, y]];
      let touchesBlack = false, touchesWhite = false;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        const key = cy * size + cx;
        if (visited.has(key)) continue;
        visited.add(key);
        region.push([cx, cy]);
        for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
          const nx = cx + dx, ny = cy + dy;
          if (!inBounds(nx, ny, size)) continue;
          if (board[ny][nx] === BLACK) touchesBlack = true;
          else if (board[ny][nx] === WHITE) touchesWhite = true;
          else if (!visited.has(ny * size + nx)) stack.push([nx, ny]);
        }
      }
      let owner = EMPTY;
      if (touchesBlack && !touchesWhite) owner = BLACK;
      else if (touchesWhite && !touchesBlack) owner = WHITE;
      for (const [rx, ry] of region) territory[ry][rx] = owner;
    }
  }
  return territory;
}

function computeScore(board, size, deadStones, komi) {
  // Remove dead stones from board
  const scoringBoard = copyBoard(board);
  for (const key of deadStones) {
    const [x, y] = key.split(',').map(Number);
    scoringBoard[y][x] = EMPTY;
  }

  const territory = floodFillTerritory(scoringBoard, size);

  let blackScore = 0, whiteScore = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (scoringBoard[y][x] === BLACK || territory[y][x] === BLACK) blackScore++;
      if (scoringBoard[y][x] === WHITE || territory[y][x] === WHITE) whiteScore++;
    }
  }
  whiteScore += komi;
  return { blackScore, whiteScore, territory };
}

// ── Stone click sound ──

let audioCtx = null;
function playStoneSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, t);
    osc.frequency.exponentialRampToValueAtTime(200, t + 0.05);
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  } catch (e) { /* audio not available */ }
}

// ── Widget ──

const PHASE_SETUP = 'setup';
const PHASE_PLAYING = 'playing';
const PHASE_SCORING = 'scoring';
const PHASE_FINISHED = 'finished';

class GobanWidget extends WidgetBase {
  activate() {
    this.size = 19;
    this.board = createBoard(this.size);
    this.history = []; // { board, move, captures }
    this.koPoint = null;
    this.turn = BLACK;
    this.consecutivePasses = 0;
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
    this.phase = PHASE_SETUP;
    this.komi = 6.5;
    this.rengo = false;

    // Players: { BLACK: [usernames], WHITE: [usernames] }
    this.players = { [BLACK]: [], [WHITE]: [] };
    // In rengo, track whose turn within the team
    this.teamTurnIndex = { [BLACK]: 0, [WHITE]: 0 };

    this.deadStones = new Set(); // keys like "x,y"
    this.scoreAccepted = new Set(); // usernames who accepted
    this.scores = null;
    this.lastMove = null;
    this.winner = null;
    this.winReason = null;
    this.moveNumber = 0;

    this.render();
  }

  deactivate() {}

  getState() {
    return {
      size: this.size,
      board: this.board,
      history: this.history.map(h => ({ move: h.move, captures: h.captures })),
      koPoint: this.koPoint,
      turn: this.turn,
      consecutivePasses: this.consecutivePasses,
      captures: this.captures,
      phase: this.phase,
      komi: this.komi,
      rengo: this.rengo,
      players: this.players,
      teamTurnIndex: this.teamTurnIndex,
      deadStones: [...this.deadStones],
      scoreAccepted: [...this.scoreAccepted],
      lastMove: this.lastMove,
      winner: this.winner,
      winReason: this.winReason,
      moveNumber: this.moveNumber,
    };
  }

  setState(data) {
    if (!data) return;
    this.size = data.size || 19;
    this.board = data.board || createBoard(this.size);
    this.koPoint = data.koPoint || null;
    this.turn = data.turn || BLACK;
    this.consecutivePasses = data.consecutivePasses || 0;
    this.captures = data.captures || { [BLACK]: 0, [WHITE]: 0 };
    this.phase = data.phase || PHASE_SETUP;
    this.komi = data.komi ?? 6.5;
    this.rengo = data.rengo || false;
    this.players = data.players || { [BLACK]: [], [WHITE]: [] };
    this.teamTurnIndex = data.teamTurnIndex || { [BLACK]: 0, [WHITE]: 0 };
    this.deadStones = new Set(data.deadStones || []);
    this.scoreAccepted = new Set(data.scoreAccepted || []);
    this.lastMove = data.lastMove || null;
    this.winner = data.winner || null;
    this.winReason = data.winReason || null;
    this.moveNumber = data.moveNumber || 0;
    // Rebuild history from moves if needed (we only sync board state, not full history)
    this.history = [];
    this.render();
  }

  onMessage(fromUser, action, data) {
    // Attach sender for handlers that need it
    data = data || {};
    if (!data.username) data.username = fromUser;
    switch (action) {
      case 'set_size': this._onSetSize(data); break;
      case 'toggle_rengo': this._onToggleRengo(data); break;
      case 'join': this._onJoin(data); break;
      case 'leave_game': this._onLeaveGame(data); break;
      case 'start': this._onStart(data); break;
      case 'move': this._onMove(data, fromUser); break;
      case 'pass': this._onPass(data, fromUser); break;
      case 'resign': this._onResign(data); break;
      case 'mark_dead': this._onMarkDead(data); break;
      case 'accept_score': this._onAcceptScore(data); break;
      case 'dispute_score': this._onDisputeScore(data); break;
      case 'new_game': this._onNewGame(data); break;
      case 'set_komi': this._onSetKomi(data); break;
    }
  }

  // ── Protocol handlers ──

  _onSetSize(data) {
    if (this.phase !== PHASE_SETUP) return;
    if (BOARD_SIZES.includes(data.size)) {
      this.size = data.size;
      this.board = createBoard(this.size);
      this.render();
    }
  }

  _onSetKomi(data) {
    if (this.phase !== PHASE_SETUP) return;
    const k = parseFloat(data.komi);
    if (!isNaN(k) && k >= 0 && k <= 100) {
      this.komi = k;
      this.render();
    }
  }

  _onToggleRengo(data) {
    if (this.phase !== PHASE_SETUP) return;
    this.rengo = !!data.rengo;
    this.render();
  }

  _onJoin(data) {
    if (this.phase !== PHASE_SETUP) return;
    const color = data.color; // BLACK or WHITE
    if (color !== BLACK && color !== WHITE) return;
    const user = data.username;
    if (!user) return;

    // Remove from other team first
    const otherColor = opponent(color);
    this.players[otherColor] = this.players[otherColor].filter(u => u !== user);

    // Add to requested team (if not already there)
    if (!this.players[color].includes(user)) {
      if (!this.rengo && this.players[color].length >= 1) {
        // In normal mode, seat is taken — ignore
        return;
      }
      this.players[color].push(user);
    }
    this.render();
  }

  _onLeaveGame(data) {
    if (this.phase !== PHASE_SETUP) return;
    const user = data.username;
    this.players[BLACK] = this.players[BLACK].filter(u => u !== user);
    this.players[WHITE] = this.players[WHITE].filter(u => u !== user);
    this.render();
  }

  _onStart(data) {
    if (this.phase !== PHASE_SETUP) return;
    if (this.players[BLACK].length === 0 || this.players[WHITE].length === 0) return;
    this.phase = PHASE_PLAYING;
    this.board = createBoard(this.size);
    this.history = [];
    this.koPoint = null;
    this.turn = BLACK;
    this.consecutivePasses = 0;
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
    this.teamTurnIndex = { [BLACK]: 0, [WHITE]: 0 };
    this.deadStones = new Set();
    this.scoreAccepted = new Set();
    this.lastMove = null;
    this.winner = null;
    this.winReason = null;
    this.moveNumber = 0;
    this.render();
  }

  _onMove(data, fromUser) {
    if (this.phase !== PHASE_PLAYING) return;
    // Verify it's this user's turn
    const team = this.players[this.turn];
    if (!this.rengo) {
      if (!team.includes(fromUser)) return;
    } else {
      if (team.length === 0 || team[this.teamTurnIndex[this.turn]] !== fromUser) return;
    }
    const { x, y } = data;
    const result = tryMove(this.board, x, y, this.turn, this.size, this.koPoint);
    if (!result) return;

    this.history.push({
      move: [x, y],
      captures: result.captured,
      board: copyBoard(this.board),
    });

    this.board = result.board;
    this.captures[this.turn] += result.captured.length;
    this.koPoint = result.koPoint;
    this.lastMove = [x, y];
    this.consecutivePasses = 0;
    this.moveNumber++;
    this._advanceTurn();
    playStoneSound();
    this.render();
  }

  _onPass(data, fromUser) {
    if (this.phase !== PHASE_PLAYING) return;
    const team = this.players[this.turn];
    if (!this.rengo) {
      if (!team.includes(fromUser)) return;
    } else {
      if (team.length === 0 || team[this.teamTurnIndex[this.turn]] !== fromUser) return;
    }
    this.consecutivePasses++;
    this.history.push({ move: 'pass', captures: [], board: copyBoard(this.board) });
    this.lastMove = null;
    this.moveNumber++;

    if (this.consecutivePasses >= 2) {
      // Enter scoring phase
      this.phase = PHASE_SCORING;
      this.deadStones = new Set();
      this.scoreAccepted = new Set();
      this._recalcScore();
      this._advanceTurn();
      this.render();
      return;
    }
    this._advanceTurn();
    this.render();
  }

  _onResign(data) {
    if (this.phase !== PHASE_PLAYING && this.phase !== PHASE_SCORING) return;
    const user = data.username;
    // Determine which color resigned
    let resignColor = null;
    if (this.players[BLACK].includes(user)) resignColor = BLACK;
    else if (this.players[WHITE].includes(user)) resignColor = WHITE;
    if (!resignColor) return;

    this.winner = opponent(resignColor);
    this.winReason = 'resignation';
    this.phase = PHASE_FINISHED;
    this.render();
  }

  _onMarkDead(data) {
    if (this.phase !== PHASE_SCORING) return;
    const { x, y } = data;
    if (!inBounds(x, y, this.size)) return;
    if (this.board[y][x] === EMPTY) return;

    // Toggle all stones in this group
    const group = getGroup(this.board, x, y, this.size);
    const key0 = `${group.stones[0][0]},${group.stones[0][1]}`;
    const isDead = this.deadStones.has(key0);

    for (const [gx, gy] of group.stones) {
      const k = `${gx},${gy}`;
      if (isDead) this.deadStones.delete(k);
      else this.deadStones.add(k);
    }

    // Reset acceptances when dead stones change
    this.scoreAccepted = new Set();
    this._recalcScore();
    this.render();
  }

  _onAcceptScore(data) {
    if (this.phase !== PHASE_SCORING) return;
    this.scoreAccepted.add(data.username);

    // Check if all players accepted
    const allPlayers = [...this.players[BLACK], ...this.players[WHITE]];
    const allAccepted = allPlayers.every(p => this.scoreAccepted.has(p));
    if (allAccepted && allPlayers.length > 0) {
      this._recalcScore();
      if (this.scores.blackScore > this.scores.whiteScore) {
        this.winner = BLACK;
      } else {
        this.winner = WHITE;
      }
      this.winReason = 'score';
      this.phase = PHASE_FINISHED;
    }
    this.render();
  }

  _onDisputeScore(data) {
    if (this.phase !== PHASE_SCORING) return;
    // Return to playing — both players agreed the dead stone marking is wrong
    this.phase = PHASE_PLAYING;
    this.consecutivePasses = 0;
    this.deadStones = new Set();
    this.scoreAccepted = new Set();
    this.scores = null;
    this.render();
  }

  _onNewGame(data) {
    this.phase = PHASE_SETUP;
    this.board = createBoard(this.size);
    this.history = [];
    this.koPoint = null;
    this.turn = BLACK;
    this.consecutivePasses = 0;
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
    this.teamTurnIndex = { [BLACK]: 0, [WHITE]: 0 };
    this.deadStones = new Set();
    this.scoreAccepted = new Set();
    this.scores = null;
    this.lastMove = null;
    this.winner = null;
    this.winReason = null;
    this.moveNumber = 0;
    // Keep players but let them reconfigure
    this.render();
  }

  _advanceTurn() {
    // Advance team turn index in rengo
    if (this.rengo && this.players[this.turn].length > 0) {
      this.teamTurnIndex[this.turn] =
        (this.teamTurnIndex[this.turn] + 1) % this.players[this.turn].length;
    }
    this.turn = opponent(this.turn);
  }

  _recalcScore() {
    this.scores = computeScore(this.board, this.size, this.deadStones, this.komi);
  }

  _isMyTurn() {
    if (this.phase !== PHASE_PLAYING) return false;
    const me = state.currentUser;
    const team = this.players[this.turn];
    if (!this.rengo) return team.includes(me);
    if (team.length === 0) return false;
    return team[this.teamTurnIndex[this.turn]] === me;
  }

  _myColor() {
    const me = state.currentUser;
    if (this.players[BLACK].includes(me)) return BLACK;
    if (this.players[WHITE].includes(me)) return WHITE;
    return null;
  }

  _isPlayer() {
    return this._myColor() !== null;
  }

  _currentPlayerName() {
    const team = this.players[this.turn];
    if (team.length === 0) return '?';
    if (!this.rengo) return team[0];
    return team[this.teamTurnIndex[this.turn]] || team[0];
  }

  // ── Rendering ──

  render() {
    const c = this.container;
    c.innerHTML = '';
    c.className = 'widget-container goban-widget';

    // Header bar
    const header = document.createElement('div');
    header.className = 'goban-header';
    header.innerHTML = this._renderHeader();
    c.appendChild(header);

    // Board area
    const boardWrap = document.createElement('div');
    boardWrap.className = 'goban-board-wrap';
    c.appendChild(boardWrap);

    const canvas = document.createElement('canvas');
    canvas.className = 'goban-canvas';
    boardWrap.appendChild(canvas);

    // Size the canvas
    this._sizeCanvas(canvas, boardWrap);

    // Draw the board
    this._drawBoard(canvas);

    // Click handler
    canvas.addEventListener('click', (e) => this._handleClick(e, canvas));

    // Hover for move preview
    canvas.addEventListener('mousemove', (e) => this._handleHover(e, canvas));
    canvas.addEventListener('mouseleave', () => {
      this._hoverPos = null;
      this._drawBoard(canvas);
    });

    // Info / controls below board
    const info = document.createElement('div');
    info.className = 'goban-info';
    info.innerHTML = this._renderInfo();
    c.appendChild(info);

    // Wire up button handlers
    this._wireButtons(info, header);
  }

  _sizeCanvas(canvas, wrap) {
    // Responsive sizing: fit within widget panel
    const maxSize = Math.min(560, window.innerWidth - 40);
    canvas.width = maxSize;
    canvas.height = maxSize;
    canvas.style.width = maxSize + 'px';
    canvas.style.height = maxSize + 'px';
  }

  _getCellSize(canvas) {
    const padding = this._getOffset(canvas);
    return (canvas.width - padding * 2) / (this.size - 1);
  }

  _getOffset() {
    // Enough room for coordinate labels outside the grid
    return 36;
  }

  _drawBoard(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const cellSize = this._getCellSize(canvas);
    const offset = this._getOffset(canvas);

    // Background
    ctx.fillStyle = '#dcb35c';
    ctx.fillRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1;
    for (let i = 0; i < this.size; i++) {
      const pos = offset + i * cellSize;
      ctx.beginPath();
      ctx.moveTo(offset, pos);
      ctx.lineTo(offset + (this.size - 1) * cellSize, pos);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pos, offset);
      ctx.lineTo(pos, offset + (this.size - 1) * cellSize);
      ctx.stroke();
    }

    // Star points
    const stars = STAR_POINTS[this.size] || [];
    for (const [sx, sy] of stars) {
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.arc(offset + sx * cellSize, offset + sy * cellSize, cellSize * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }

    // Coordinate labels
    ctx.fillStyle = '#1a1a1a';
    ctx.font = `${Math.max(9, cellSize * 0.35)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const colLabels = 'ABCDEFGHJKLMNOPQRST'; // Skip I
    for (let i = 0; i < this.size; i++) {
      const x = offset + i * cellSize;
      ctx.fillText(colLabels[i], x, offset + (this.size - 1) * cellSize + cellSize * 0.7);
      ctx.fillText(colLabels[i], x, offset - cellSize * 0.7);
      const rowLabel = String(this.size - i);
      ctx.fillText(rowLabel, offset - cellSize * 0.7, offset + i * cellSize);
      ctx.fillText(rowLabel, offset + (this.size - 1) * cellSize + cellSize * 0.7, offset + i * cellSize);
    }

    // Stones
    const stoneRadius = cellSize * 0.45;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const stone = this.board[y][x];
        if (stone === EMPTY) continue;

        const cx = offset + x * cellSize;
        const cy = offset + y * cellSize;
        const isDead = this.phase === PHASE_SCORING && this.deadStones.has(`${x},${y}`);

        ctx.beginPath();
        ctx.arc(cx, cy, stoneRadius, 0, Math.PI * 2);

        if (stone === BLACK) {
          ctx.fillStyle = isDead ? 'rgba(30,30,30,0.4)' : '#1a1a1a';
        } else {
          ctx.fillStyle = isDead ? 'rgba(240,240,240,0.4)' : '#f0f0f0';
        }
        ctx.fill();

        if (stone === WHITE) {
          ctx.strokeStyle = isDead ? 'rgba(100,100,100,0.4)' : '#666';
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Dead stone marker
        if (isDead) {
          ctx.strokeStyle = '#e74c3c';
          ctx.lineWidth = 2;
          const m = stoneRadius * 0.5;
          ctx.beginPath();
          ctx.moveTo(cx - m, cy - m);
          ctx.lineTo(cx + m, cy + m);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx + m, cy - m);
          ctx.lineTo(cx - m, cy + m);
          ctx.stroke();
        }

        // Last move marker
        if (this.lastMove && this.lastMove[0] === x && this.lastMove[1] === y) {
          ctx.strokeStyle = stone === BLACK ? '#fff' : '#000';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx, cy, stoneRadius * 0.35, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // Territory markers during scoring
    if (this.phase === PHASE_SCORING && this.scores) {
      const territory = this.scores.territory;
      for (let y = 0; y < this.size; y++) {
        for (let x = 0; x < this.size; x++) {
          if (this.board[y][x] !== EMPTY && !this.deadStones.has(`${x},${y}`)) continue;
          const t = territory[y][x];
          if (t === EMPTY) continue;
          const cx = offset + x * cellSize;
          const cy = offset + y * cellSize;
          const markerSize = cellSize * 0.15;
          ctx.fillStyle = t === BLACK ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.8)';
          ctx.fillRect(cx - markerSize, cy - markerSize, markerSize * 2, markerSize * 2);
          if (t === WHITE) {
            ctx.strokeStyle = 'rgba(100,100,100,0.6)';
            ctx.lineWidth = 1;
            ctx.strokeRect(cx - markerSize, cy - markerSize, markerSize * 2, markerSize * 2);
          }
        }
      }
    }

    // Ko point marker
    if (this.koPoint && this.phase === PHASE_PLAYING) {
      const [kx, ky] = this.koPoint;
      const cx = offset + kx * cellSize;
      const cy = offset + ky * cellSize;
      ctx.strokeStyle = '#e74c3c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, cellSize * 0.2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Hover preview
    if (this._hoverPos && this.phase === PHASE_PLAYING && this._isMyTurn()) {
      const [hx, hy] = this._hoverPos;
      if (this.board[hy][hx] === EMPTY) {
        const cx = offset + hx * cellSize;
        const cy = offset + hy * cellSize;
        ctx.beginPath();
        ctx.arc(cx, cy, stoneRadius, 0, Math.PI * 2);
        ctx.fillStyle = this.turn === BLACK ? 'rgba(30,30,30,0.3)' : 'rgba(240,240,240,0.3)';
        ctx.fill();
      }
    }
  }

  _boardCoordsFromEvent(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const cellSize = this._getCellSize(canvas);
    const offset = this._getOffset(canvas);
    const x = Math.round((mx - offset) / cellSize);
    const y = Math.round((my - offset) / cellSize);
    if (!inBounds(x, y, this.size)) return null;
    return [x, y];
  }

  _handleClick(e, canvas) {
    const coords = this._boardCoordsFromEvent(e, canvas);
    if (!coords) return;
    const [x, y] = coords;

    if (this.phase === PHASE_PLAYING) {
      if (!this._isMyTurn()) return;
      // Validate locally before sending
      const result = tryMove(this.board, x, y, this.turn, this.size, this.koPoint);
      if (!result) return;
      this.send('move', { x, y, username: state.currentUser });
    } else if (this.phase === PHASE_SCORING) {
      if (!this._isPlayer()) return;
      if (this.board[y][x] === EMPTY) return;
      this.send('mark_dead', { x, y, username: state.currentUser });
    }
  }

  _handleHover(e, canvas) {
    const coords = this._boardCoordsFromEvent(e, canvas);
    this._hoverPos = coords;
    this._drawBoard(canvas);
  }

  _renderHeader() {
    const colorName = c => c === BLACK ? 'Black' : 'White';
    let status = '';

    if (this.phase === PHASE_SETUP) {
      status = `<span class="goban-status">Setting up — ${this.size}×${this.size}${this.rengo ? ' Rengo' : ''}</span>`;
    } else if (this.phase === PHASE_PLAYING) {
      const name = this._currentPlayerName();
      const turnColor = colorName(this.turn);
      const dot = this.turn === BLACK ? '⚫' : '⚪';
      status = `<span class="goban-status">${dot} ${turnColor}'s turn — ${esc(name)}${this._isMyTurn() ? ' (you)' : ''} · Move ${this.moveNumber + 1}</span>`;
    } else if (this.phase === PHASE_SCORING) {
      status = `<span class="goban-status">Scoring — click groups to mark dead</span>`;
    } else if (this.phase === PHASE_FINISHED) {
      const winColor = colorName(this.winner);
      if (this.winReason === 'resignation') {
        status = `<span class="goban-status">${winColor} wins by resignation!</span>`;
      } else {
        const b = this.scores?.blackScore ?? 0;
        const w = this.scores?.whiteScore ?? 0;
        status = `<span class="goban-status">${winColor} wins! B: ${b} W: ${w}</span>`;
      }
    }

    let html = `<div class="goban-header-row">${status}</div>`;

    // Captures display
    if (this.phase !== PHASE_SETUP) {
      html += `<div class="goban-captures">
        <span>⚫ Captures: ${this.captures[BLACK]}</span>
        <span>⚪ Captures: ${this.captures[WHITE]}</span>
        <span>Komi: ${this.komi}</span>
      </div>`;
    }

    return html;
  }

  _renderInfo() {
    let html = '';

    if (this.phase === PHASE_SETUP) {
      html += this._renderSetup();
    } else if (this.phase === PHASE_PLAYING) {
      html += this._renderPlayControls();
    } else if (this.phase === PHASE_SCORING) {
      html += this._renderScoringControls();
    } else if (this.phase === PHASE_FINISHED) {
      html += this._renderFinished();
    }

    return html;
  }

  _renderSetup() {
    const me = state.currentUser;
    const myColor = this._myColor();

    let html = '<div class="goban-setup">';

    // Board size
    html += '<div class="goban-setup-row"><label>Board size:</label>';
    for (const s of BOARD_SIZES) {
      const active = s === this.size ? 'active' : '';
      html += `<button class="goban-btn goban-size-btn ${active}" data-action="set_size" data-size="${s}">${s}×${s}</button>`;
    }
    html += '</div>';

    // Komi
    html += `<div class="goban-setup-row"><label>Komi:</label>
      <input type="number" class="goban-komi-input" value="${this.komi}" step="0.5" min="0" max="100" data-action="set_komi">
    </div>`;

    // Rengo toggle
    html += `<div class="goban-setup-row">
      <label>
        <input type="checkbox" class="goban-rengo-check" ${this.rengo ? 'checked' : ''} data-action="toggle_rengo">
        Rengo (team play)
      </label>
    </div>`;

    // Player slots
    html += '<div class="goban-players">';
    html += this._renderPlayerSlot(BLACK, myColor);
    html += this._renderPlayerSlot(WHITE, myColor);
    html += '</div>';

    // Start button
    const canStart = this.players[BLACK].length > 0 && this.players[WHITE].length > 0;
    html += `<button class="goban-btn goban-start-btn" data-action="start" ${canStart ? '' : 'disabled'}>Start Game</button>`;

    html += '</div>';
    return html;
  }

  _renderPlayerSlot(color, myColor) {
    const colorName = color === BLACK ? 'Black' : 'White';
    const dot = color === BLACK ? '⚫' : '⚪';
    const players = this.players[color];
    const me = state.currentUser;
    const amOnThisTeam = players.includes(me);

    let html = `<div class="goban-player-slot">
      <div class="goban-slot-header">${dot} ${colorName}</div>
      <div class="goban-slot-players">`;

    if (players.length === 0) {
      html += '<span class="goban-empty-slot">Empty</span>';
    } else {
      html += players.map(p => `<span class="goban-player-name">${esc(p)}</span>`).join(', ');
    }

    html += '</div>';

    if (!amOnThisTeam) {
      html += `<button class="goban-btn goban-join-btn" data-action="join" data-color="${color}">Join ${colorName}</button>`;
    } else {
      html += `<button class="goban-btn goban-leave-btn" data-action="leave_game">Leave</button>`;
    }

    html += '</div>';
    return html;
  }

  _renderPlayControls() {
    const isPlayer = this._isPlayer();
    const isMyTurn = this._isMyTurn();
    let html = '<div class="goban-controls">';

    // Player info
    html += '<div class="goban-player-info">';
    html += `<span>⚫ ${this.players[BLACK].map(esc).join(', ') || '?'}</span>`;
    html += `<span>⚪ ${this.players[WHITE].map(esc).join(', ') || '?'}</span>`;
    html += '</div>';

    if (isPlayer) {
      html += `<button class="goban-btn" data-action="pass" ${isMyTurn ? '' : 'disabled'}>Pass</button>`;
      html += `<button class="goban-btn goban-resign-btn" data-action="resign">Resign</button>`;
    }

    html += '</div>';
    return html;
  }

  _renderScoringControls() {
    const isPlayer = this._isPlayer();
    const allPlayers = [...this.players[BLACK], ...this.players[WHITE]];
    const accepted = allPlayers.filter(p => this.scoreAccepted.has(p));
    const me = state.currentUser;
    const iAccepted = this.scoreAccepted.has(me);

    let html = '<div class="goban-scoring">';

    if (this.scores) {
      html += `<div class="goban-score-display">
        <span>⚫ Black: ${this.scores.blackScore}</span>
        <span>⚪ White: ${this.scores.whiteScore} (incl. ${this.komi} komi)</span>
      </div>`;
    }

    html += `<div class="goban-score-status">Accepted: ${accepted.length}/${allPlayers.length}
      ${accepted.length > 0 ? '(' + accepted.map(esc).join(', ') + ')' : ''}</div>`;

    if (isPlayer) {
      if (!iAccepted) {
        html += `<button class="goban-btn" data-action="accept_score">Accept Score</button>`;
      }
      html += `<button class="goban-btn goban-dispute-btn" data-action="dispute_score">Dispute (Resume Play)</button>`;
    }

    html += '</div>';
    return html;
  }

  _renderFinished() {
    let html = '<div class="goban-finished">';
    html += `<div class="goban-player-info">
      <span>⚫ ${this.players[BLACK].map(esc).join(', ') || '?'}</span>
      <span>⚪ ${this.players[WHITE].map(esc).join(', ') || '?'}</span>
    </div>`;
    html += `<button class="goban-btn goban-start-btn" data-action="new_game">New Game</button>`;
    html += '</div>';
    return html;
  }

  _wireButtons(info, header) {
    // Buttons with data-action
    const allBtns = [...this.container.querySelectorAll('[data-action]')];
    for (const btn of allBtns) {
      const action = btn.dataset.action;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        switch (action) {
          case 'set_size':
            this.send('set_size', { size: parseInt(btn.dataset.size) });
            break;
          case 'toggle_rengo':
            this.send('toggle_rengo', { rengo: btn.checked });
            break;
          case 'join':
            this.send('join', { color: parseInt(btn.dataset.color), username: state.currentUser });
            break;
          case 'leave_game':
            this.send('leave_game', { username: state.currentUser });
            break;
          case 'start':
            this.send('start', {});
            break;
          case 'pass':
            this.send('pass', { username: state.currentUser });
            break;
          case 'resign':
            if (confirm('Are you sure you want to resign?')) {
              this.send('resign', { username: state.currentUser });
            }
            break;
          case 'accept_score':
            this.send('accept_score', { username: state.currentUser });
            break;
          case 'dispute_score':
            this.send('dispute_score', { username: state.currentUser });
            break;
          case 'new_game':
            this.send('new_game', {});
            break;
        }
      });
    }

    // Komi input
    const komiInput = this.container.querySelector('.goban-komi-input');
    if (komiInput) {
      komiInput.addEventListener('change', () => {
        this.send('set_komi', { komi: parseFloat(komiInput.value) || 6.5 });
      });
    }

    // Rengo checkbox
    const rengoCheck = this.container.querySelector('.goban-rengo-check');
    if (rengoCheck) {
      rengoCheck.addEventListener('change', () => {
        this.send('toggle_rengo', { rengo: rengoCheck.checked });
      });
    }
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

registerWidget('goban', 'Go (Goban)', GobanWidget);
