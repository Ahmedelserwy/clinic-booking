import { Injectable, signal } from '@angular/core';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

/**
 * The animated icon a success toast plays. Anything that is not `success` ignores it.
 *
 *   check     generic confirmation (default)
 *   ecg       a heartbeat line that ends in a check - saved clinical data
 *   heart     a beating heart that turns into a check - a new patient
 *   cross     a medical cross - doctors, prescriptions, treatment
 *   calendar  a calendar stamped as confirmed - appointments and work hours
 *   receipt   a receipt sliding out - money (expenses, payments)
 */
export type ToastKind = 'check' | 'ecg' | 'heart' | 'cross' | 'calendar' | 'receipt';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  /** The animation a success toast plays. Defaults to `check`. */
  kind?: ToastKind;
  /** A second line under the message: who, when, how much. */
  detail?: string;
  /** Milliseconds before it closes itself. `0` keeps it until it is dismissed. */
  duration?: number;
  /** A button on the toast, e.g. Undo or Print. Clicking it also closes the toast. */
  action?: ToastAction;
}

export interface ToastItem {
  id: number;
  type: ToastType;
  kind: ToastKind;
  message: string;
  detail: string | null;
  duration: number;
  action: ToastAction | null;
  paused: boolean;
  /** True while the exit animation plays, just before the toast is removed. */
  leaving: boolean;
}

interface Timer {
  handle: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  remaining: number;
}

/** More than this on screen at once is noise; the oldest one makes room. */
const MAX_VISIBLE = 3;

/** How long the exit animation runs before the toast is taken off the page. */
const LEAVE_MS = 260;

/**
 * How long each kind stays on screen, in milliseconds. Hovering a toast pauses
 * the countdown, and `duration: 0` in the options keeps one until it is closed.
 */
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 6000,
  info: 6000,
  warning: 8000,
  error: 10000,
};

/**
 * The list of toasts on screen and the timers that close them.
 *
 * Kept apart from `NotificationService` so the host component and the service
 * can both depend on it without depending on each other.
 */
@Injectable({ providedIn: 'root' })
export class ToastStore {
  readonly toasts = signal<ToastItem[]>([]);

  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  show(type: ToastType, message: string, options: ToastOptions = {}): number {
    const detail = options.detail?.trim() || null;

    // The same message twice in a row replaces itself instead of stacking.
    const duplicate = this.toasts().find(
      (toast) => toast.type === type && toast.message === message && toast.detail === detail
    );
    if (duplicate) {
      this.dismiss(duplicate.id, true);
    }

    const duration = options.duration ?? DEFAULT_DURATION[type];
    const item: ToastItem = {
      id: this.nextId++,
      type,
      kind: options.kind ?? 'check',
      message,
      detail,
      duration,
      action: options.action ?? null,
      paused: false,
      leaving: false,
    };

    const list = [...this.toasts(), item];
    const overflow = list.splice(0, Math.max(0, list.length - MAX_VISIBLE));
    overflow.forEach((toast) => this.clear(toast.id));
    this.toasts.set(list);

    if (duration > 0) {
      this.timers.set(item.id, { handle: null, startedAt: 0, remaining: duration });
      this.run(item.id);
    }

    return item.id;
  }

  /** Closes a toast with its exit animation; `immediate` skips the animation. */
  dismiss(id: number, immediate = false): void {
    this.clear(id);

    if (immediate) {
      this.remove(id);
      return;
    }

    const toast = this.toasts().find((entry) => entry.id === id);
    if (!toast || toast.leaving) {
      return;
    }

    this.patch(id, { leaving: true });
    setTimeout(() => this.remove(id), LEAVE_MS);
  }

  /** Hovering or focusing a toast stops its countdown so it can be read. */
  pause(id: number): void {
    const timer = this.timers.get(id);
    if (!timer || timer.handle === null) {
      return;
    }

    clearTimeout(timer.handle);
    timer.handle = null;
    timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
    this.setPaused(id, true);
  }

  resume(id: number): void {
    const timer = this.timers.get(id);
    if (!timer || timer.handle !== null) {
      return;
    }

    this.run(id);
    this.setPaused(id, false);
  }

  runAction(id: number): void {
    const toast = this.toasts().find((entry) => entry.id === id);
    this.dismiss(id);
    toast?.action?.run();
  }

  private run(id: number): void {
    const timer = this.timers.get(id);
    if (!timer) {
      return;
    }

    timer.startedAt = Date.now();
    // Never less than a moment, so a toast resumed at the last instant can still be seen.
    timer.handle = setTimeout(() => this.dismiss(id), Math.max(timer.remaining, 600));
  }

  private clear(id: number): void {
    const timer = this.timers.get(id);
    if (timer?.handle) {
      clearTimeout(timer.handle);
    }
    this.timers.delete(id);
  }

  private setPaused(id: number, paused: boolean): void {
    this.patch(id, { paused });
  }

  private patch(id: number, changes: Partial<ToastItem>): void {
    this.toasts.update((list) =>
      list.map((toast) => (toast.id === id ? { ...toast, ...changes } : toast))
    );
  }

  private remove(id: number): void {
    this.toasts.update((list) => list.filter((toast) => toast.id !== id));
  }
}