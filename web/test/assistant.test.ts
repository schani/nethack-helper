import { describe, expect, it } from 'vitest';
import { assistantHotkey, type HotkeyTarget } from '../src/assistant/hotkeys.ts';

function target(state = 'idle') {
  const calls: string[] = [];
  const t: HotkeyTarget = {
    client: { state, toggleMute: () => calls.push('mute'), pushToTalk: (d) => calls.push(`ptt:${d}`) },
    toggleSession: () => calls.push('session'),
    focusInput: () => calls.push('input'),
  };
  return { t, calls };
}
const ev = (key: string, type = 'keydown', mods: Record<string, boolean> = {}) => ({
  key, code: key, type, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...mods,
});

describe('assistant hotkeys', () => {
  it('F2 starts the session when idle and toggles the mic when connected', () => {
    const a = target('idle');
    expect(assistantHotkey(ev('F2'), a.t)).toBe(true);
    expect(a.calls).toEqual(['session']);
    const b = target('connected');
    assistantHotkey(ev('F2'), b.t);
    assistantHotkey(ev('F2', 'keyup'), b.t);
    expect(b.calls).toEqual(['mute']);
  });
  it('F3 is push-to-talk while connected', () => {
    const a = target('connected');
    assistantHotkey(ev('F3'), a.t);
    assistantHotkey(ev('F3', 'keydown', { repeat: true }), a.t);
    assistantHotkey(ev('F3', 'keyup'), a.t);
    expect(a.calls).toEqual(['ptt:true', 'ptt:false']);
  });
  it('F4 focuses the chat input; other keys and modified F-keys are not handled', () => {
    const a = target('connected');
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
