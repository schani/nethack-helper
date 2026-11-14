import type { KeyLike } from '../keys.ts';

/** The parts of the assistant panel the hotkeys drive. */
export interface HotkeyTarget {
  client: { readonly state: string; toggleMute(): void; pushToTalk(down: boolean): void };
  toggleSession(): void;
  focusInput(): void;
}

/**
 * Global assistant hotkeys on keys NetHack's tty interface does not use
 * (function keys only reach it as escape sequences it would misread):
 *   F2       start the assistant; while running: mic on/off
 *   F3 hold  push-to-talk (mic open while held)
 *   F4       focus the chat input (Esc returns to the game)
 * Returns true if the event was handled (caller swallows it).
 */
export function assistantHotkey(ev: KeyLike & { type: string; repeat?: boolean }, target: HotkeyTarget): boolean {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return false;
  const down = ev.type === 'keydown';
  const live = target.client.state === 'connected';
  switch (ev.key) {
    case 'F2':
      if (down && !ev.repeat) {
        if (live) target.client.toggleMute();
        else if (target.client.state === 'idle' || target.client.state === 'error') target.toggleSession();
      }
      return true;
    case 'F3':
      if (live && !ev.repeat) target.client.pushToTalk(down);
      return true;
    case 'F4':
      if (down) target.focusInput();
      return true;
    default:
      return false;
  }
}
