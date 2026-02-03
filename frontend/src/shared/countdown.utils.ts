export interface CountdownConfig {
  durationSeconds: number;
  onTick?: (remainingSeconds: number) => void;
  onComplete: () => void;
}

export class CountdownTimer {
  private intervalId: number | null = null;
  private remaining: number;
  private config: CountdownConfig;

  constructor(config: CountdownConfig) {
    this.config = config;
    this.remaining = config.durationSeconds;
  }

  start() {
    this.intervalId = window.setInterval(() => {
      this.remaining--;
      this.config.onTick?.(this.remaining);
      if (this.remaining <= 0) {
        this.stop();
        this.config.onComplete();
      }
    }, 1000);
  }

  stop() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getRemaining(): number {
    return this.remaining;
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
