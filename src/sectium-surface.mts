import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import type { RecipeEvent } from './recipe-runner.mts';

export type SectiumChannel = 'command' | 'display';

export type SectiumPipeFrame = {
  channel: SectiumChannel;
  type: string;
  surfaceId?: string;
  payload?: Record<string, unknown>;
  timestamp: string;
};

export type SectiumSurfaceOptions = {
  pipePath?: string;
  surfaceId?: string;
  appVersion?: string;
};

/**
 * Returns the canonical Sectium Host Device Pipe address:
 * - Windows: `\\.\pipe\sectium-dev`
 * - POSIX: `/tmp/sectium-dev.sock`
 */
export function getDefaultSectiumPipePath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? '\\\\.\\pipe\\sectium-dev' : '/tmp/sectium-dev.sock';
}

/**
 * Clean Pinokio UI surface adapted from `pinokio-cdp.mts` to route exclusively over the
 * Sectium Host Device Pipe (`\\.\pipe\sectium-dev` / `/tmp/sectium-dev.sock`) using dual
 * orthogonal NDJSON channels (`command` + `display`) — zero 250 MB Electron monolith and
 * zero `127.0.0.1` loopback HTTP control plane.
 */
export class SectiumPinokioSurface extends EventEmitter {
  public readonly pipePath: string;
  public readonly surfaceId: string;
  public readonly appVersion: string;
  private socket: net.Socket | null = null;
  private readonly pendingFrames: SectiumPipeFrame[] = [];

  constructor(options: SectiumSurfaceOptions = {}) {
    super();
    this.pipePath = options.pipePath ?? getDefaultSectiumPipePath();
    this.surfaceId = options.surfaceId ?? 'pinokio-surface';
    this.appVersion = options.appVersion ?? '0.1.0';
  }

  public createFrame(
    channel: SectiumChannel,
    type: string,
    payload?: Record<string, unknown>,
  ): SectiumPipeFrame {
    return {
      channel,
      type,
      surfaceId: this.surfaceId,
      payload,
      timestamp: new Date().toISOString(),
    };
  }

  public encodeFrame(frame: SectiumPipeFrame): string {
    return `${JSON.stringify(frame)}\n`;
  }

  /**
   * Connects to an already-powered-on Sectium Host Device pipe.
   * Never spawns `sectium.exe` or Electron directly (Power-Button invariant).
   */
  public async connect(): Promise<{ connected: boolean; pipePath: string; error?: string }> {
    return await new Promise((resolve) => {
      const socket = net.createConnection(this.pipePath);
      let settled = false;
      let buffer = '';

      socket.once('connect', () => {
        settled = true;
        this.socket = socket;
        for (const frame of this.pendingFrames.splice(0)) {
          socket.write(this.encodeFrame(frame));
        }
        this.emit('connected', { pipePath: this.pipePath });
        resolve({ connected: true, pipePath: this.pipePath });
      });

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line) {
            try {
              const parsed = JSON.parse(line) as SectiumPipeFrame;
              this.emit('frame', parsed);
            } catch {
              this.emit('raw-line', line);
            }
          }
          newlineIdx = buffer.indexOf('\n');
        }
      });

      socket.once('error', (err) => {
        if (!settled) {
          settled = true;
          resolve({
            connected: false,
            pipePath: this.pipePath,
            error: `DEVICE_OFFLINE (${err.message})`,
          });
        } else {
          this.emit('error', err);
        }
      });

      socket.on('close', () => {
        this.socket = null;
        this.emit('disconnected', { pipePath: this.pipePath });
      });
    });
  }

  public sendFrame(
    channel: SectiumChannel,
    type: string,
    payload?: Record<string, unknown>,
  ): SectiumPipeFrame {
    const frame = this.createFrame(channel, type, payload);
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(this.encodeFrame(frame));
    } else {
      this.pendingFrames.push(frame);
    }
    this.emit('frame:sent', frame);
    return frame;
  }

  /**
   * Opens a pure visual app surface on the Sectium `display` channel.
   */
  public openAppSurface(appId: string, target: string): SectiumPipeFrame {
    return this.sendFrame('display', 'open_surface', {
      appId,
      target,
      renderer: 'sectium-canvas',
    });
  }

  /**
   * Streams recipe lifecycle and CAS hydration telemetry over the `command` channel.
   */
  public emitRecipeEvent(event: RecipeEvent): SectiumPipeFrame {
    return this.sendFrame('command', `pinokio:${event.type}`, {
      event,
    });
  }

  /**
   * Returns a declarative HTML5 `<b8g-*>` Web Component snippet bound to the Sectium pipe.
   */
  public toWebComponentMarkup(): string {
    return [
      `<b8g-sectium-command data-pipe="${this.pipePath}" data-channel="command" data-surface="${this.surfaceId}"></b8g-sectium-command>`,
      `<b8g-sectium-display data-pipe="${this.pipePath}" data-channel="display" data-surface="${this.surfaceId}"></b8g-sectium-display>`,
    ].join('\n');
  }

  public close(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }
    this.socket = null;
  }
}

export default SectiumPinokioSurface;
