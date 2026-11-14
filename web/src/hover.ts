import type { Terminal } from '@xterm/xterm';
import type { GameState, MapCell } from '../../shared/feed-events.ts';

/**
 * Hovering a map cell shows NetHack's farlook description of it
 * (from the state feed).  Map coordinates: x = column + 1, y = row - 1.
 */
export function attachHover(term: Terminal, host: HTMLElement, tip: HTMLElement, getState: () => GameState | null) {
  let index: Map<number, MapCell> | null = null;
  let indexedFor: GameState | null = null;

  const lookup = (x: number, y: number): MapCell | null => {
    const st = getState();
    if (!st || !st.currentLevel) return null;
    if (indexedFor !== st) {
      index = new Map();
      for (const c of st.levels[st.currentLevel]?.cells ?? []) index.set(c.y * 80 + c.x, c);
      indexedFor = st;
    }
    return index!.get(y * 80 + x) ?? null;
  };

  host.addEventListener('mousemove', (e) => {
    const screen = host.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return;
    const r = screen.getBoundingClientRect();
    const col = Math.floor(((e.clientX - r.left) / r.width) * term.cols);
    const row = Math.floor(((e.clientY - r.top) / r.height) * term.rows);
    const x = col + 1;
    const y = row - 1;
    const cell = row >= 1 && row <= 21 ? lookup(x, y) : null;
    if (!cell) {
      tip.classList.add('hidden');
      return;
    }
    tip.textContent = '';
    const head = document.createElement('div');
    head.className = 'tip-head';
    head.textContent = `${cell.ch}  ${cell.desc || '?'}`;
    const body = document.createElement('div');
    body.className = 'tip-body';
    body.textContent = cell.look;
    tip.append(head, body);
    const wrap = host.parentElement!.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX - wrap.left + 14, wrap.width - 300)}px`;
    tip.style.top = `${e.clientY - wrap.top + 18}px`;
    tip.classList.remove('hidden');
  });
  host.addEventListener('mouseleave', () => tip.classList.add('hidden'));
}
