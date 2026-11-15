import type { KeyLike } from '../keys.ts';

/** The parts of the assistant panel the hotkeys drive. */
export interface HotkeyTarget {
  client: { toggleMic(): void; pushToTalk(down: boolean): void };
  focusInput(): void;
}

/**
 * Global assistant hotkeys on keys NetHack's tty interface does not use
 * (function keys only reach it as escape sequences it would misread):
 *   F2       mic on/off (connects the assistant if needed)
 *   F3 hold  push-to-talk (mic open while held)
 *   F4       focus the chat input (Esc returns to the game)
 * Returns true if the event was handled (caller swallows it).
 */
export function assistantHotkey(ev: KeyLike & { type: string; repeat?: boolean }, target: HotkeyTarget): boolean {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return false;
  const down = ev.type === 'keydown';
  switch (ev.key) {
    case 'F2':
      if (down && !ev.repeat) target.client.toggleMic();
      return true;
    case 'F3':
      if (!ev.repeat) target.client.pushToTalk(down);
      return true;
    case 'F4':
      if (down) target.focusInput();
      return true;
    default:
      return false;
  }
}
