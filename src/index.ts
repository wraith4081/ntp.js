import dgram from 'dgram';
import { EventEmitter } from 'events';

const SEVENTY_YEARS_IN_SECONDS = 2208988800;
const NTP_PACKET_SIZE = 48;
const NTP_DEFAULT_PORT = 123;

type SyncStatus = 'synced' | 'syncing' | 'error';

interface NTPClientOptions {
  poolServerName?: string;
  port?: number;
  timeOffset?: number;
  updateInterval?: number;
  maxRetries?: number;
}

enum NTP_EVENTS {
  ERROR = 'error',
  SYNC = 'sync',
  SYNC_STATUS = 'syncStatus',
  SYNCED = 'synced',
  SYNCING = 'syncing',
}

interface NTPClientEvents {
  [NTP_EVENTS.ERROR]: (error: Error) => void;
  [NTP_EVENTS.SYNC]: (time: number) => void;
  [NTP_EVENTS.SYNC_STATUS]: (status: SyncStatus) => void;
  [NTP_EVENTS.SYNCED]: () => void;
  [NTP_EVENTS.SYNCING]: () => void;
}

class NTPClient extends EventEmitter {
  private readonly udp: dgram.Socket;
  private udpSetup: boolean = false;
  private readonly poolServerName: string;
  private readonly port: number;
  private timeOffset: number;
  private updateInterval: number;
  private syncedTime: number = 0;
  private lastSyncTime: number = 0;
  private roundTripDelay: number = 0;
  private localClockOffset: number = 0;
  private interval: NodeJS.Timeout | null = null;
  private retryCount: number = 0;
  private readonly maxRetries: number;
  private syncStatus: SyncStatus = 'syncing';

  constructor(options: NTPClientOptions = {}) {
    super();
    this.udp = dgram.createSocket('udp4');
    this.poolServerName = options.poolServerName || "pool.ntp.org";
    this.port = options.port || NTP_DEFAULT_PORT;
    this.timeOffset = options.timeOffset || 0;
    this.updateInterval = options.updateInterval || 60000;
    this.maxRetries = options.maxRetries || 3;

    this.setupUDPListeners();
  }

  private setupUDPListeners(): void {
    this.udp.on('error', (err: Error) => {
      this.handleError('UDP error', err);
    });

    this.udp.on('message', (msg: Buffer) => {
      this.processNTPPacket(msg);
    });
  }

  public begin(): void {
    if (!this.udpSetup) {
      this.udp.bind(0, () => {
        this.udpSetup = true;
        this.startInterval();
        this.forceUpdate();
      });
    } else {
      this.startInterval();
      this.forceUpdate();
    }
  }

  private startInterval(): void {
    this.stopInterval();
    this.interval = setInterval(() => {
      this.forceUpdate();
    }, this.updateInterval);
  }

  private stopInterval(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  public forceUpdate(): void {
    this.setSyncStatus(NTP_EVENTS.SYNCING);
    this.sendNTPPacket();
    this.lastSyncTime = Date.now();
    this.retryCount = 0;
  }

  private sendNTPPacket(): void {
    const packetBuffer = Buffer.alloc(NTP_PACKET_SIZE);
    packetBuffer[0] = 0b11100011;   // LI, Version, Mode
    packetBuffer[1] = 0;     // Stratum, or type of clock
    packetBuffer[2] = 6;     // Polling Interval
    packetBuffer[3] = 0xEC;  // Peer Clock Precision
    // 8 bytes of zero for Root Delay & Root Dispersion
    packetBuffer[12] = 49;
    packetBuffer[13] = 0x4E;
    packetBuffer[14] = 49;
    packetBuffer[15] = 52;
    packetBuffer.writeUInt32BE(Math.floor(Date.now() / 1000 + SEVENTY_YEARS_IN_SECONDS), 40);

    this.udp.send(packetBuffer, 0, packetBuffer.length, this.port, this.poolServerName, (err) => {
      if (err) {
        this.handleError('Error sending NTP packet', err);
        this.handleSendError();
      }
    });
  }

  private handleSendError(): void {
    if (++this.retryCount < this.maxRetries) {
      setTimeout(() => this.sendNTPPacket(), 1000);
    } else {
      this.handleError('Max retries reached. NTP sync failed.', new Error('Max retries exceeded'));
      this.setSyncStatus(NTP_EVENTS.ERROR);
    }
  }

  private processNTPPacket(msg: Buffer): void {
    const receiveTimestamp = Date.now();
    const originateTimestamp = msg.readUInt32BE(24) - SEVENTY_YEARS_IN_SECONDS;
    const receiveServerTimestamp = msg.readUInt32BE(32) - SEVENTY_YEARS_IN_SECONDS;
    const transmitServerTimestamp = msg.readUInt32BE(40) - SEVENTY_YEARS_IN_SECONDS;

    this.roundTripDelay = (receiveTimestamp - this.lastSyncTime) - (transmitServerTimestamp - receiveServerTimestamp);
    this.localClockOffset = ((receiveServerTimestamp - originateTimestamp) + (transmitServerTimestamp - receiveTimestamp)) / 2;

    this.syncedTime = receiveTimestamp + this.localClockOffset + this.timeOffset;
    this.setSyncStatus(NTP_EVENTS.SYNCED);
    this.emit(NTP_EVENTS.SYNC, this.getTime());
  }

  public getTime(): number {
    if (this.syncStatus !== NTP_EVENTS.SYNCED) {
      return 0; // Time not synced yet
    }
    return this.syncedTime + (Date.now() - this.lastSyncTime);
  }

  public getSyncStatus(): SyncStatus {
    return this.syncStatus;
  }

  public setTimeOffset(offset: number): void {
    this.timeOffset = offset;
    if (this.syncStatus === NTP_EVENTS.SYNCED) {
      this.syncedTime += offset;
    }
  }

  public setUpdateInterval(interval: number): void {
    this.updateInterval = interval;
    if (this.interval) {
      this.startInterval();
    }
  }

  public stop(): void {
    this.stopInterval();
    this.udp.close();
  }

  private setSyncStatus(status: SyncStatus): void {
    this.syncStatus = status;
    this.emit(NTP_EVENTS.SYNC_STATUS, this.syncStatus);
  }

  private handleError(message: string, error: Error): void {
    this.emit(NTP_EVENTS.ERROR, error);
  }

  public on<E extends keyof NTPClientEvents>(event: E, listener: NTPClientEvents[E]): this {
    return super.on(event, listener);
  }

  public emit<E extends keyof NTPClientEvents>(event: E, ...args: Parameters<NTPClientEvents[E]>): boolean {
    return super.emit(event, ...args);
  }
}

export default NTPClient;
export { NTP_EVENTS };
