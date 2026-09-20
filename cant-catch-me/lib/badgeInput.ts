import type { InputState } from './game';
import { emptyBadgeButtons, type BadgeButton, type BadgeButtons } from './badgeControllerTypes';

/** Keep device state separate from keyboard/touch, and require release after menus. */
export class BadgeInput {
  buttons = emptyBadgeButtons();
  private blocked = new Set<BadgeButton>();
  private startArmed = false;
  private cameraArmed = false;

  update(next: BadgeButtons) {
    const actions = {
      start: this.startArmed && next.start && !this.buttons.start,
      camera: this.cameraArmed && next.a && !this.buttons.a,
    };
    if (!next.start) this.startArmed = true;
    if (!next.a) this.cameraArmed = true;
    this.buttons = { ...next };
    for (const button of this.blocked) if (!next[button]) this.blocked.delete(button);
    return actions;
  }

  clear() {
    for (const button of Object.keys(this.buttons) as BadgeButton[]) {
      if (this.buttons[button]) this.blocked.add(button);
    }
  }

  reset() {
    this.buttons = emptyBadgeButtons();
    this.blocked.clear();
    this.startArmed = false;
    this.cameraArmed = false;
  }

  held(button: BadgeButton) { return this.buttons[button] && !this.blocked.has(button); }

  merge(keyboard: InputState): InputState {
    return {
      throttle: keyboard.throttle < 0 || this.held('down') ? -1 : Number(keyboard.throttle > 0 || this.held('up')),
      steer: Math.max(-1, Math.min(1, keyboard.steer + Number(this.held('right')) - Number(this.held('left')))),
    };
  }
}
