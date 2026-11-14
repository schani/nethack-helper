import '@xterm/xterm/css/xterm.css';
import './style.css';
import { Terminal } from '@xterm/xterm';
import type { GameState, InputKind, ServerMessage, SessionInfo } from '../../shared/feed-events.ts';
import { lightTheme, fontFamily } from './theme.ts';
import { translateKey, translateMeta } from './keys.ts';
import { setupFullscreen } from './fullscreen.ts';
import { Connection } from './connection.ts';
import { DebugDrawer } from './debug.ts';
import { attachHover } from './hover.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let cols = 80;
let rows = 24;
let state: GameState | null = null;
let session: SessionInfo | null = null;

const term = new Terminal({
  cols,
  rows,
  theme: lightTheme,
  fontFamily,
  fontSize: 17,
  lineHeight: 1.0,
  letterSpacing: 0,
  cursorBlink: false,
  cursorStyle: 'block',
  scrollback: 0,
  allowProposedApi: true,
  // NetHack draws its own UI; never let the browser select-scroll
  disableStdin: false,
  macOptionIsMeta: true,
  drawBoldTextInBrightColors: false,
  minimumContrastRatio: 1,
});
term.open($('terminal'));

const conn = new Connection(onMessage);

// keystrokes -> game
term.onData((data) => conn.send({ type: 'input', data }));
/** Alt+key -> NetHack Meta key; true if handled */
function sendMeta(ev: KeyboardEvent, awaiting: InputKind | null): boolean {
  const meta = translateMeta(ev, awaiting);
  if (meta === null) return false;
  ev.preventDefault();
  if (meta) conn.send({ type: 'input', data: meta, meta: true });
  return true;
}

term.attachCustomKeyEventHandler((ev) => {
  if (ev.type !== 'keydown') return true;
  const awaiting = (state?.awaiting?.kind ?? null) as InputKind | null;
  if (sendMeta(ev, awaiting)) return false;
  const out = translateKey(ev, awaiting);
  if (out === null) return true; // xterm encodes it normally
  ev.preventDefault();
  if (out) conn.send({ type: 'input', data: out });
  return false;
});

// size the font so 80x24 fills the pane with crisp integer pixel sizes
function fitFont() {
  const pane = $('game-pane');
  const wrap = $('term-wrap');
  const screen = document.querySelector('#terminal .xterm-screen') as HTMLElement | null;
  const size = term.options.fontSize ?? 17;
  // measured cell size per px of font size (falls back to DejaVu-ish ratios)
  const rect = screen?.getBoundingClientRect();
  const kw = rect && rect.width > 0 ? rect.width / cols / size : 0.602;
  const kh = rect && rect.height > 0 ? rect.height / rows / size : 1.17;
  const hint = $('hint');
  const availW = pane.clientWidth - 20; // wrap padding + border
  const availH = pane.clientHeight - hint.offsetHeight - 8 /* gap */ - 20; /* wrap padding + border */
  const best = Math.max(11, Math.min(30, Math.floor(Math.min(availW / (kw * cols), availH / (kh * rows)))));
  if (best !== size) term.options.fontSize = best;
}
window.addEventListener('resize', fitFont);

function sessionLabel(s: SessionInfo | null, connected: boolean): string {
  if (!connected) return 'disconnected — reconnecting…';
  if (!s) return 'connecting…';
  if (s.state === 'running') return `playing as ${s.player} (pid ${s.pid})`;
  if (s.state === 'exited') return `game ended (exit ${s.exitCode ?? '?'}${s.signal ? `, signal ${s.signal}` : ''})`;
  return 'idle';
}

let connected = false;
conn.onStatus = (c) => {
  connected = c;
  renderSession();
};

function renderSession() {
  $('session-label').textContent = sessionLabel(session, connected);
  const overlay = $('overlay');
  const show = connected && session !== null && session.state !== 'running';
  overlay.classList.toggle('hidden', !show);
  if (show && session) {
    $('overlay-title').textContent = session.state === 'exited' ? 'NetHack has exited' : 'The game is not running';
    $('overlay-text').textContent =
      session.state === 'exited'
        ? 'If you saved (S), starting again resumes your game. After a death or quit a new character is created.'
        : 'Start a new game or resume your saved one.';
  }
}

$('start-btn').addEventListener('click', () => {
  conn.send({ type: 'start' });
  term.focus();
});

function onMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'snapshot':
      if (msg.cols !== cols || msg.rows !== rows) {
        cols = msg.cols;
        rows = msg.rows;
        term.resize(cols, rows);
        fitFont();
      }
      term.reset();
      term.write(msg.data);
      session = msg.session;
      renderSession();
      break;
    case 'output':
      term.write(msg.data);
      break;
    case 'session':
      session = msg.session;
      renderSession();
      break;
    case 'state':
      state = msg.state;
      drawer.onLiveState(msg.state);
      break;
  }
}

const drawer = new DebugDrawer(() => requestAnimationFrame(fitFont));
$('debug-toggle').addEventListener('click', () => {
  drawer.toggle();
  requestAnimationFrame(fitFont);
  term.focus();
});

// Ctrl keys the browser reserves: fullscreen + Keyboard Lock, or the palette
setupFullscreen({
  button: $('fullscreen-btn') as HTMLButtonElement,
  palette: $('key-palette'),
  onChange: () => requestAnimationFrame(fitFont),
});
for (const btn of document.querySelectorAll<HTMLButtonElement>('#key-palette .key')) {
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the game
  btn.addEventListener('click', () => {
    // ^T = 0x14 etc.
    conn.send({ type: 'input', data: String.fromCharCode(btn.dataset.ctrl!.charCodeAt(0) - 64) });
    term.focus();
  });
}

attachHover(term, $('terminal'), $('tooltip'), () => state);

// keep keyboard focus on the game
$('game-pane').addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('button')) setTimeout(() => term.focus(), 0);
});
// after using any control outside the terminal, give focus back
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('button, input, label')) setTimeout(() => term.focus(), 0);
});
// keys typed while nothing in particular has focus still go to the game
document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  if (active && active !== document.body && active.tagName !== 'BUTTON') return;
  term.focus();
  const awaiting = (state?.awaiting?.kind ?? null) as InputKind | null;
  if (sendMeta(e, awaiting)) return;
  let out = translateKey(e, awaiting);
  if (out === null) {
    if (e.key === 'Escape') out = '\x1b';
    else if (e.key === 'Enter') out = '\r';
    else if (e.key === 'Backspace') out = '\x7f';
    else if (e.ctrlKey && /^[a-z]$/i.test(e.key)) out = String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
    else if (e.key.length === 1 && !e.altKey && !e.metaKey) out = e.key;
    else return;
  }
  e.preventDefault();
  if (out) conn.send({ type: 'input', data: out });
});

fitFont();
requestAnimationFrame(fitFont);
void document.fonts?.ready.then(() => fitFont());
if (new URLSearchParams(location.search).has('palette')) {
  // ?palette : offline legibility check of the 16 NetHack colors on the light theme
  const names = ['black', 'red', 'green', 'brown', 'blue', 'magenta', 'cyan', 'gray',
    'no-color', 'orange', 'bright green', 'yellow', 'bright blue', 'bright magenta', 'bright cyan', 'white'];
  term.write('NetHack colors on the light theme (setaf N, as the tty port emits them):\r\n\r\n');
  names.forEach((n, i) => {
    const sgr = i < 8 ? `\x1b[3${i}m` : `\x1b[9${i - 8}m`;
    term.write(`${sgr}  ${String(i).padStart(2)} ${n.padEnd(15)} @ d F { # % ) [ ! ? / = " + $ \x1b[0m   ${sgr}\x1b[7m inverse \x1b[0m\r\n`);
  });
  term.write('\r\n  default fg (NetHack gray): |....@....|  -----  #####\r\n');
} else {
  conn.connect();
}
term.focus();
