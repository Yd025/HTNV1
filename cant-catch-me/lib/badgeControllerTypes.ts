export type BadgeButton = 'up' | 'down' | 'left' | 'right' | 'start' | 'a' | 'b';
export type BadgeButtons = Record<BadgeButton, boolean>;
export type BadgeStatus = 'disconnected' | 'connecting' | 'waiting' | 'connected' | 'error';

export interface BadgeConnectionCallbacks {
  onButtons(buttons: BadgeButtons, baseline?: boolean): void;
  onStatus(status: BadgeStatus, message: string): void;
}

export const emptyBadgeButtons = (): BadgeButtons => ({
  up: false, down: false, left: false, right: false, start: false, a: false, b: false,
});
