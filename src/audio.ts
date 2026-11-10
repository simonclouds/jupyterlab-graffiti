const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

export type MicResult = 'ok' | 'insecure' | 'denied' | 'missing';

export interface MicStart {
  result: MicResult;
  label: string;
}

export class AudioCapture {
  private recorder: MediaRecorder | undefined;
  private chunks: Blob[] = [];
  private stream: MediaStream | undefined;
  private generation = 0;

  async start(): Promise<MicStart> {
    const generation = ++this.generation;
    this.releaseStream();
    this.recorder = undefined;
    this.chunks = [];
    if (!window.isSecureContext) {
      return { result: 'insecure', label: '' };
    }
    const media = navigator.mediaDevices;
    if (!media || !media.getUserMedia) {
      return { result: 'missing', label: '' };
    }
    try {
      let stream = await media.getUserMedia({ audio: true });
      if (generation !== this.generation) {
        stopTracks(stream);
        return { result: 'denied', label: '' };
      }
      stream = await openPhysicalMic(stream);
      if (generation !== this.generation) {
        stopTracks(stream);
        return { result: 'denied', label: '' };
      }
      this.stream = stream;
      const mimeType = recorderMime();
      this.recorder = mimeType
        ? new MediaRecorder(this.stream, { mimeType })
        : new MediaRecorder(this.stream);
      this.recorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) {
          this.chunks.push(event.data);
        }
      };
      this.recorder.start(250);
      return { result: 'ok', label: trackLabel(this.stream) };
    } catch {
      if (generation === this.generation) {
        this.releaseStream();
        this.recorder = undefined;
      }
      return { result: 'denied', label: '' };
    }
  }

  async stop(): Promise<string> {
    this.generation += 1;
    const recorder = this.recorder;
    if (!recorder) {
      this.releaseStream();
      return '';
    }
    const done = new Promise<void>(resolve => {
      recorder.onstop = () => resolve();
    });
    if (recorder.state !== 'inactive') {
      recorder.stop();
      await done;
    }
    this.releaseStream();
    this.recorder = undefined;
    if (this.chunks.length === 0) {
      return '';
    }
    const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
    const buffer = await blob.arrayBuffer();
    return bytesToBase64(new Uint8Array(buffer));
  }

  private releaseStream(): void {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = undefined;
    }
  }
}

function stopTracks(stream: MediaStream): void {
  if (stream && typeof stream.getTracks === 'function') {
    stream.getTracks().forEach(track => track.stop());
  }
}

function trackLabel(stream: MediaStream | undefined): string {
  if (!stream || typeof stream.getAudioTracks !== 'function') {
    return '';
  }
  const track = stream.getAudioTracks()[0];
  return track && track.label ? track.label : '';
}

function isVirtualMic(label: string): boolean {
  return /blackhole|virtual|doubao|oray|soundflower|loopback|vb-audio/i.test(label);
}

async function openPhysicalMic(stream: MediaStream): Promise<MediaStream> {
  const currentLabel = trackLabel(stream);
  if (currentLabel && !isVirtualMic(currentLabel)) {
    return stream;
  }
  const media = navigator.mediaDevices;
  if (!media || !media.enumerateDevices || !media.getUserMedia) {
    return stream;
  }
  try {
    const devices = await media.enumerateDevices();
    const mics = devices.filter(
      device => device.kind === 'audioinput' && device.deviceId && device.label && !isVirtualMic(device.label)
    );
    const builtin = mics.find(device => /built-in|内置|macbook/i.test(device.label));
    const chosen = builtin || mics[0];
    if (!chosen || chosen.label === currentLabel) {
      return stream;
    }
    const next = await media.getUserMedia({
      audio: { deviceId: { exact: chosen.deviceId } }
    });
    stopTracks(stream);
    return next;
  } catch {
    return stream;
  }
}

function recorderMime(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    return 'audio/webm;codecs=opus';
  }
  if (MediaRecorder.isTypeSupported('audio/webm')) {
    return 'audio/webm';
  }
  return '';
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class AudioPlayback {
  private audio: HTMLAudioElement | undefined;
  private objectUrl = '';

  arm(): void {
    if (!this.audio) {
      this.audio = new Audio();
    }
    this.audio.autoplay = true;
    this.audio.src = SILENT_WAV;
    void this.audio.play().catch(() => undefined);
  }

  load(base64: string): void {
    if (!this.audio) {
      this.audio = new Audio();
    }
    this.audio.pause();
    this.revokeUrl();
    if (!base64) {
      this.audio.removeAttribute('src');
      return;
    }
    const bytes = base64ToBytes(base64);
    const blob = new Blob([bytes], { type: 'audio/webm' });
    this.objectUrl = URL.createObjectURL(blob);
    this.audio.src = this.objectUrl;
  }

  play(offsetMs: number, speed: number, muted: boolean): void {
    const audio = this.audio;
    if (!audio || !audio.src) {
      return;
    }
    const start = (): void => {
      audio.playbackRate = speed;
      audio.muted = muted;
      audio.volume = muted ? 0 : 1;
      if (offsetMs > 0 && audio.seekable.length > 0) {
        audio.currentTime = offsetMs / 1000;
      }
      void audio.play().catch(() => undefined);
    };
    if (audio.readyState >= 1) {
      start();
    } else {
      audio.addEventListener('loadedmetadata', start, { once: true });
    }
  }

  pause(): void {
    if (this.audio) {
      this.audio.pause();
    }
  }

  setMuted(muted: boolean): void {
    if (this.audio) {
      this.audio.muted = muted;
    }
  }

  setSpeed(speed: number): void {
    if (this.audio) {
      this.audio.playbackRate = speed;
    }
  }

  seek(offsetMs: number): void {
    if (this.audio) {
      this.audio.currentTime = offsetMs / 1000;
    }
  }

  stop(): void {
    if (!this.audio) {
      return;
    }
    this.audio.pause();
    this.audio.src = '';
    this.audio = undefined;
    this.revokeUrl();
  }

  private revokeUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
    }
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/[\r\n]/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
