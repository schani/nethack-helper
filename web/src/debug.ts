import type { GameState } from '../../shared/feed-events.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Collapsible drawer showing GET /api/state: a readable summary by default,
 * or the raw JSON.  Refreshes from the server while open.
 */
export class DebugDrawer {
  private open = false;
  private timer: number | null = null;
  private drawer = $('drawer');
  private body = $('drawer-body');

  private onLayout: () => void;

  constructor(onLayout: () => void) {
    this.onLayout = onLayout;
    $('drawer-close').addEventListener('click', () => this.toggle(false));
    $('all-levels').addEventListener('change', () => this.refresh());
    $('raw-json').addEventListener('change', () => this.refresh());
  }

  toggle(force?: boolean) {
    this.open = force ?? !this.open;
    this.drawer.classList.toggle('collapsed', !this.open);
    this.onLayout();
    if (this.open) {
      void this.refresh();
      this.timer = window.setInterval(() => void this.refresh(), 1000);
    } else if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** live ws state (current level only) — nothing to do unless open */
  onLiveState(_st: GameState) {}

  async refresh() {
    if (!this.open) return;
    const all = ($('all-levels') as HTMLInputElement).checked;
    const raw = ($('raw-json') as HTMLInputElement).checked;
    let st: GameState;
    try {
      st = await (await fetch(`/api/state${all ? '' : '?level=current'}`)).json();
    } catch {
      return;
    }
    $('drawer-meta').textContent = `seq ${st.feed.lastSeq} · ${st.feed.events} events · feed ${st.feed.connected ? 'connected' : 'disconnected'}`;
    // preserve scroll position across refreshes
    const scroll = this.body.scrollTop;
    this.body.textContent = '';
    if (raw) {
      this.body.append(el('pre', 'json', JSON.stringify(st, null, 2)));
    } else {
      this.body.append(this.summary(st));
    }
    this.body.scrollTop = scroll;
  }

  private summary(st: GameState): HTMLElement {
    const root = el('div', 'summary');

    const col1 = el('div', 'col');
    const kv = (k: string, v: string) => {
      const row = el('div', 'kv');
      row.append(el('span', 'k', k), el('span', 'v', v));
      return row;
    };
    col1.append(el('h4', '', 'Game'));
    col1.append(kv('session', `${st.session.state} ${st.session.pid ?? ''}`));
    col1.append(kv('turn', String(st.turn)));
    col1.append(kv('hero', st.hero ? `${st.hero.x},${st.hero.y}` : '-'));
    const aw = st.awaiting;
    col1.append(kv('awaiting', aw ? `${aw.kind}${aw.prompt ? `: ${aw.prompt}` : ''}` : '-'));
    const lvl = st.currentLevel ? st.levels[st.currentLevel]?.info : null;
    col1.append(kv('level', lvl ? `${lvl.long_desc} (${st.currentLevel})${lvl.known.length ? ' ' + lvl.known.join(',') : ''}` : '-'));
    col1.append(kv('levels seen', Object.keys(st.levels).join(' ') || '-'));
    if (st.status) {
      col1.append(el('h4', '', 'Status'));
      const f = st.status.fields;
      col1.append(kv('', Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join('  ')));
      if (st.status.conditions.length) col1.append(kv('conditions', st.status.conditions.join(', ')));
    }
    col1.append(el('h4', '', 'Inventory'));
    const inv = el('ul', 'inv');
    for (const it of st.inventory) {
      inv.append(el('li', '', `${it.letter} - ${it.text}${it.slots.length ? `  [${it.slots.join(',')}]` : ''}`));
    }
    col1.append(inv);

    const col2 = el('div', 'col');
    col2.append(el('h4', '', 'Messages (latest last)'));
    const msgs = el('ul', 'msgs');
    for (const m of st.messages.slice(-25)) msgs.append(el('li', m.source ?? '', `T${m.turn}: ${m.text}`));
    col2.append(msgs);
    if (st.menu) {
      col2.append(el('h4', '', `Open menu: ${st.menu.prompt}`));
      col2.append(el('pre', 'menu', st.menu.items.map((i) => `${i.ch ?? ' '} ${i.text}`).join('\n')));
    }

    const col3 = el('div', 'col wide');
    col3.append(el('h4', '', 'Map memory (current level) + notable cells'));
    const cur = st.currentLevel ? st.levels[st.currentLevel] : null;
    if (cur) {
      col3.append(el('pre', 'map', cur.rows.join('\n')));
      const notable = cur.cells.filter((c) => !/^(wall|floor of a room|dark part of a room|corridor|stone)$/.test(c.desc));
      const ul = el('ul', 'cells');
      for (const c of notable.slice(0, 80)) ul.append(el('li', '', `${c.ch} (${c.x},${c.y}) ${c.desc} — ${c.look}`));
      col3.append(ul);
    }
    root.append(col1, col2, col3);
    return root;
  }
}
