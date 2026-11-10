export class PlaybackClock {
  time = 0;
  playing = false;
  speed = 1;

  constructor(public duration: number) {}

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  seek(time: number): void {
    this.time = clamp(time, 0, this.duration);
    if (this.time >= this.duration) {
      this.playing = false;
    }
  }

  tick(deltaMs: number): void {
    if (!this.playing) {
      return;
    }
    this.seek(this.time + deltaMs * this.speed);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
