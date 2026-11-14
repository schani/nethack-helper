/**
 * Fullscreen mode with the Keyboard Lock API (Chromium): while locked, the
 * page receives keys the browser normally keeps (Ctrl+W/T/N, and Esc no
 * longer leaves fullscreen unless held).  Browsers without the API get the
 * compact key palette instead.
 */

interface KeyboardLock {
  lock(codes?: string[]): Promise<void>;
  unlock(): void;
}

const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard;
export const keyboardLockSupported = typeof keyboard?.lock === 'function';

export interface FullscreenUi {
  button: HTMLButtonElement;
  palette: HTMLElement;
  onChange?: () => void;
}

export function setupFullscreen(ui: FullscreenUi) {
  let locked = false;
  const canFullscreen = typeof document.documentElement.requestFullscreen === 'function';

  const render = () => {
    const fs = document.fullscreenElement !== null;
    ui.button.textContent = fs ? 'Exit fullscreen' : 'Fullscreen';
    ui.button.title = keyboardLockSupported
      ? 'Fullscreen also captures Ctrl+W/T/N and Esc for the game (hold Esc to leave)'
      : 'Fullscreen (this browser cannot capture Ctrl+W/T/N: use the key buttons)';
    // the palette is only needed while the browser still owns those keys
    ui.palette.classList.toggle('hidden', locked);
    ui.onChange?.();
  };

  ui.button.classList.toggle('hidden', !canFullscreen);
  ui.button.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (keyboardLockSupported) {
        await keyboard!.lock!(); // all keys
        locked = true;
      }
    } catch (err) {
      console.warn('fullscreen / keyboard lock failed', err);
    }
    render();
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && locked) {
      keyboard?.unlock?.();
      locked = false;
    }
    render();
  });
  render();
}
