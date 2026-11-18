import { describe, expect, it } from 'vitest';
import { assistantHotkey, type HotkeyTarget } from '../src/assistant/hotkeys.ts';

function target() {
  const calls: string[] = [];
  const t: HotkeyTarget = {
    client: { toggleMic: () => calls.push('mic'), pushToTalk: (d) => calls.push(`ptt:${d}`) },
    focusInput: () => calls.push('input'),
  };
  return { t, calls };
}
const ev = (key: string, type = 'keydown', mods: Record<string, boolean> = {}) => ({
  key, code: key, type, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...mods,
});

describe('assistant hotkeys', () => {
  it('F2 toggles the mic on keydown only (no separate start: the client connects lazily)', () => {
    const a = target();
    expect(assistantHotkey(ev('F2'), a.t)).toBe(true);
    expect(assistantHotkey(ev('F2', 'keyup'), a.t)).toBe(true);
    assistantHotkey(ev('F2', 'keydown', { repeat: true }), a.t);
    assistantHotkey(ev('F2'), a.t);
    expect(a.calls).toEqual(['mic', 'mic']);
  });
  it('F3 is push-to-talk: down opens, auto-repeat ignored, up restores', () => {
    const a = target();
    assistantHotkey(ev('F3'), a.t);
    assistantHotkey(ev('F3', 'keydown', { repeat: true }), a.t);
    assistantHotkey(ev('F3', 'keyup'), a.t);
    expect(a.calls).toEqual(['ptt:true', 'ptt:false']);
  });
  it('F4 focuses the chat input; other keys and modified F-keys are not handled', () => {
    const a = target();
    expect(assistantHotkey(ev('F4'), a.t)).toBe(true);
    expect(assistantHotkey(ev('f'), a.t)).toBe(false);
    expect(assistantHotkey(ev('F2', 'keydown', { ctrlKey: true }), a.t)).toBe(false);
    expect(a.calls).toEqual(['input']);
  });
});

import { chipLabel } from '../src/assistant/panel.ts';

describe('tool chip labels', () => {
  it('are short and human readable', () => {
    expect(chipLabel('look', '{"target":"f"}')).toBe('look f');
    expect(chipLabel('get_level_map', '{"level":"1"}')).toBe('map 1');
    expect(chipLabel('fetch_wiki_page', '{"title":"Fountain","section":"Quaffing"}')).toBe('wiki Fountain § Quaffing');
    expect(chipLabel('get_status', '')).toBe('status');
    expect(chipLabel('look', '{"targ')).toBe('look around'); // arguments still streaming
  });
});

describe('expert chip', async () => {
  const { expertLabel, chipLabel } = await import('../src/assistant/panel.ts');
  const base = { startedAt: 1000, finishedAt: undefined as number | undefined, result: undefined as any, interrupted: undefined as boolean | undefined };
  it('shows elapsed time while thinking, then the outcome', () => {
    expect(expertLabel({ ...base, status: 'running' }, 13_400)).toBe('Thinking… 12 s');
    expect(expertLabel({ ...base, depth: 'deep', status: 'running' }, 13_400)).toBe('Thinking deeply… 12 s');
    expect(expertLabel({ ...base, status: 'ready', finishedAt: 31_000, result: { ok: true } as any }, 40_000)).toBe('Thinker answer ready (30 s)');
    expect(expertLabel({ ...base, status: 'delivered', finishedAt: 31_000, result: { ok: true } as any, interrupted: true }, 40_000)).toBe('Thinker answered (30 s), interrupted');
    expect(expertLabel({ ...base, status: 'delivered', result: { ok: false } as any }, 40_000)).toBe('Thinker couldn’t finish');
    expect(expertLabel({ ...base, status: 'cancelled' }, 40_000)).toBe('Thinker cancelled');
    expect(chipLabel('ask_thinker', '{"question":"x","depth":"quick"}')).toBe('ask thinker');
    expect(chipLabel('ask_thinker', '{"question":"x","depth":"deep"}')).toBe('ask thinker (deep)');
  });
});
