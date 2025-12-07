import dgram from 'dgram';
import dns from 'dns';
import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';

const SEVENTY_YEARS_IN_SECONDS = 2208988800;
const NTP_PACKET_SIZE = 48;
const NTP_DEFAULT_PORT = 123;
const DEFAULT_RTT_THRESHOLD = 250;

type SyncStatus = 'synced' | 'syncing' | 'error';

interface NTPClientOptions {
  /** NTP server hostname. Default: 'pool.ntp.org' */
  poolServerName?: string;
  /** NTP server port. Default: 123 */
  port?: number;
  /** Additional time offset in milliseconds. Default: 0 */
  timeOffset?: number;
  /** Time between sync attempts in milliseconds. Default: 60000 */
  updateInterval?: number;
  /** Maximum retry attempts per sync cycle. Default: 3 */
  maxRetries?: number;
  /** UDP protocol preference. Default: 'udp4' */
  protocol?: 'udp4' | 'udp6';
  /** RTT threshold in ms for outlier filtering. Responses with RTT above this are ignored. Default: 250 */
  rttThreshold?: number;
}

/** Event types emitted by NTPClient */
enum NTP_EVENTS {
  /** Emitted when an error occurs */
  ERROR = 'error',
  /** Emitted when time is successfully synchronized */
  SYNC = 'sync',
  /** Emitted when sync status changes */
  SYNC_STATUS = 'syncStatus',
}

interface NTPClientEvents {
  [NTP_EVENTS.ERROR]: (error: Error) => void;
  [NTP_EVENTS.SYNC]: (time: number) => void;
  [NTP_EVENTS.SYNC_STATUS]: (status: SyncStatus) => void;
}

/**
 * A robust Network Time Protocol (NTP) client implementation for Node.js applications
 * with high-precision time synchronization and clock drift compensation.
 * 
 * @example
 * ```typescript
 * const ntpClient = new NTPClient();
 * ntpClient.on(NTP_EVENTS.SYNC, (time) => console.log('Synced:', new Date(time)));
 * ntpClient.begin();
 * ```
 */
class NTPClient extends EventEmitter {
  private udp: dgram.Socket;
  private udpSetup: boolean = false;
  private readonly poolServerName: string;
  private readonly port: number;
  private timeOffset: number;
  private updateInterval: number;
  private syncedTime: number = 0;
  private roundTripDelay: number = 0;
  private interval: NodeJS.Timeout | null = null;
  private retryCount: number = 0;
  /** Maximum number of retry attempts per sync cycle */
  public readonly maxRetries: number;
  /** RTT threshold in milliseconds for outlier filtering */
  public readonly rttThreshold: number;
  private timeHistory: Array<{ localHighRes: number; realTime: number }> = [];
  private skewSlope: number = 1;
  private skewIntercept: number = 0;
  private pendingRequests: Map<string, { highRes: number; unix: number; timeoutId: NodeJS.Timeout }> = new Map();
  private syncStatus: SyncStatus = 'syncing';
  private currentProtocol: 'udp4' | 'udp6' = 'udp4';

  /**
   * Creates a new NTPClient instance.
   * @param options - Configuration options for the NTP client
   * @throws {Error} If port is not between 1 and 65535
   * @throws {Error} If updateInterval is not greater than 0
   * @throws {Error} If maxRetries is negative
   * @throws {Error} If rttThreshold is not greater than 0
   */
  constructor(options: NTPClientOptions = {}) {
    super();

    if (options.port !== undefined && (options.port < 1 || options.port > 65535)) {
      throw new Error('Port must be between 1 and 65535');
    }
    if (options.updateInterval !== undefined && options.updateInterval <= 0) {
      throw new Error('Update interval must be greater than 0');
    }
    if (options.maxRetries !== undefined && options.maxRetries < 0) {
      throw new Error('Max retries must be non-negative');
    }
    if (options.rttThreshold !== undefined && options.rttThreshold <= 0) {
      throw new Error('RTT threshold must be greater than 0');
    }

    this.currentProtocol = options.protocol || 'udp4';
    this.udp = dgram.createSocket(this.currentProtocol);
    this.poolServerName = options.poolServerName || "pool.ntp.org";
    this.port = options.port || NTP_DEFAULT_PORT;
    this.timeOffset = options.timeOffset || 0;
    this.updateInterval = options.updateInterval || 60000;
    this.maxRetries = options.maxRetries || 3;
    this.rttThreshold = options.rttThreshold || DEFAULT_RTT_THRESHOLD;

    this.setupUDPListeners();
  }

  private setupUDPListeners(): void {
    this.udp.removeAllListeners('error');
    this.udp.removeAllListeners('message');

    this.udp.on('error', (err: Error) => {
      this.handleError('UDP error', err);
    });

    this.udp.on('message', (msg: Buffer) => {
      this.processNTPPacket(msg);
    });
  }

  /**
   * Starts the NTP client with burst synchronization on startup.
   * Sends 4 packets at 2-second intervals for faster initial time lock,
   * then switches to the configured update interval.
   */
  public begin(): void {
    if (!this.udpSetup) {
      this.udp.bind(0, () => {
        this.udpSetup = true;
        this.burstSync();
      });
    } else {
      this.burstSync();
    }
  }

  // Perform initial burst synchronization for faster clock convergence
  private burstSync(): void {
    // We will send 4 packets with 2s interval
    let burstCount = 0;
    const maxBurst = 4;
    const burstInterval = 2000;

    const sendBurst = () => {
      if (burstCount >= maxBurst) {
        // Burst done, switch to normal interval
        this.startInterval();
        return;
      }
      this.forceUpdate();
      burstCount++;
      setTimeout(sendBurst, burstInterval);
    };

    sendBurst();
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

  /**
   * Forces an immediate time synchronization.
   * Resets retry count and sends a new NTP packet.
   * @returns Promise that resolves when the packet is sent (not when response is received)
   */
  public async forceUpdate(): Promise<void> {
    this.setSyncStatus('syncing');
    // Reset retry count at the start of a new update cycle
    this.retryCount = 0;
    await this.sendNTPPacket();
  }

  private async dnsLookup(hostname: string): Promise<{ address: string; family: number }> {
    return new Promise((resolve, reject) => {
      dns.lookup(hostname, { all: false }, (err, address, family) => {
        if (err) {
          reject(err);
        } else {
          resolve({ address, family });
        }
      });
    });
  }

  private async sendNTPPacket(): Promise<void> {
    try {
      const { address, family } = await this.dnsLookup(this.poolServerName);
      const requiredProtocol = family === 6 ? 'udp6' : 'udp4';

      if (this.currentProtocol !== requiredProtocol) {
        // Switch socket to match resolved address family
        this.udp.close();
        this.udp = dgram.createSocket(requiredProtocol);
        this.currentProtocol = requiredProtocol;
        this.setupUDPListeners();
        // Bind and wait for completion to prevent race conditions with send()
        await new Promise<void>((resolve) => this.udp.bind(0, resolve));
      }

      const packetBuffer = Buffer.alloc(NTP_PACKET_SIZE);
      // NTP packet header: LI=0 (no warning), VN=3 (version 3), Mode=3 (client)
      // Binary: 00 011 011 = 0x1B = 0b00011011
      packetBuffer[0] = 0b00011011;   // LI=0, Version=3, Mode=3 (Client)
      packetBuffer[1] = 0;     // Stratum, or type of clock
      packetBuffer[2] = 6;     // Polling Interval
      packetBuffer[3] = 0xEC;  // Peer Clock Precision
      // 8 bytes of zero for Root Delay & Root Dispersion
      packetBuffer[12] = 49;
      packetBuffer[13] = 0x4E;
      packetBuffer[14] = 49;
      packetBuffer[15] = 52;

      const nowUnix = Date.now();
      const nowHighRes = performance.now();

      const ntpSec = Math.floor(nowUnix / 1000 + SEVENTY_YEARS_IN_SECONDS);
      const baseNtpFrac = Math.floor(((nowUnix % 1000) / 1000) * 0x100000000);

      // Add 16-bit random fuzz to fraction to prevent ID collisions on same-millisecond packets
      const randomFuzz = Math.floor(Math.random() * 0xFFFF);
      const uniqueNtpFrac = (baseNtpFrac + randomFuzz) >>> 0; // Ensure unsigned 32-bit

      // Use Transmit Timestamp as unique ID for request matching
      const packetID = `${ntpSec}:${uniqueNtpFrac}`;

      // Set timeout for this specific packet
      const timeoutId = setTimeout(() => {
        this.handleReqTimeout(packetID);
      }, 3000); // 3 seconds timeout

      this.pendingRequests.set(packetID, { highRes: nowHighRes, unix: nowUnix, timeoutId });

      packetBuffer.writeUInt32BE(ntpSec, 40);
      packetBuffer.writeUInt32BE(uniqueNtpFrac, 44);

      this.udp.send(packetBuffer, 0, packetBuffer.length, this.port, address, (err) => {
        if (err) {
          // If send fails immediately, clear the timeout and handle error
          const pending = this.pendingRequests.get(packetID);
          if (pending) {
            clearTimeout(pending.timeoutId);
            this.pendingRequests.delete(packetID);
          }
          this.handleError('Error sending NTP packet', err);
          // We could retry here effectively the same as a timeout
          this.handleSendError();
        }
      });
    } catch (err: any) {
      this.handleError('DNS Lookup failed', err);
      this.handleSendError();
    }
  }

  private handleReqTimeout(packetID: string): void {
    if (this.pendingRequests.has(packetID)) {
      this.pendingRequests.delete(packetID);
      // Timeout occurred logic
      this.handleSendError();
    }
  }

  private handleSendError(): void {
    if (++this.retryCount < this.maxRetries) {
      // Wait a bit before retrying
      setTimeout(() => this.sendNTPPacket(), 1000);
    } else {
      this.handleError('Max retries reached. NTP sync failed.', new Error('Max retries exceeded'));
      this.setSyncStatus('error');
    }
  }

  private processNTPPacket(msg: Buffer): void {
    const receiveHighRes = performance.now();

    const mode = msg.readUInt8(0) & 0x07;
    const stratum = msg.readUInt8(1);

    // validate Mode must be 4 (Server)
    if (mode !== 4) {
      return; // Ignore invalid mode
    }

    // Validate Stratum (Reject KoD or Unsynced)
    if (stratum === 0 || stratum === 16) {
      return;
    }

    // Origin Timestamp (T1) in response must match Transmit Timestamp (T3) of request
    const originSeconds = msg.readUInt32BE(24);
    const originFraction = msg.readUInt32BE(28);
    const packetID = `${originSeconds}:${originFraction}`;

    const pending = this.pendingRequests.get(packetID);
    if (!pending) return; // Unmatched or timed out

    // Remove from pending
    this.pendingRequests.delete(packetID);
    // Clear timeout to prevent unnecessary retry
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    const receiveServerTimestamp = NTPClient.ntpToMilliseconds(msg.readUInt32BE(32), msg.readUInt32BE(36));
    const transmitServerTimestamp = NTPClient.ntpToMilliseconds(msg.readUInt32BE(40), msg.readUInt32BE(44));

    // Standard NTP calculations

    const t1_p = pending.highRes;
    const t4_p = receiveHighRes;
    const T2 = receiveServerTimestamp;
    const T3 = transmitServerTimestamp;

    // Calculate local delay and server processing time
    const localElapsed = t4_p - t1_p;
    const serverProcessing = T3 - T2;
    this.roundTripDelay = Math.max(0, localElapsed - serverProcessing);

    // Estimate real time at T4: T3 + One-way Delay (approx RTT/2)
    const realTimeAtT4 = T3 + (this.roundTripDelay / 2);

    const isOutlier = this.roundTripDelay > this.rttThreshold;

    if (!isOutlier) {
      this.addTimeSample(t4_p, realTimeAtT4);
      this.recalculateSkew();
    }

    this.syncedTime = this.getTime(); // Current estimate
    this.retryCount = 0; // Reset retry count triggers on valid sync
    this.setSyncStatus('synced');
    this.emit(NTP_EVENTS.SYNC, this.syncedTime);
  }

  private addTimeSample(localHighRes: number, realTime: number): void {
    this.timeHistory.push({ localHighRes, realTime });
    if (this.timeHistory.length > 20) {
      this.timeHistory.shift(); // Keep last 20 samples
    }
  }

  private recalculateSkew(): void {
    if (this.timeHistory.length < 2) {
      // Not enough data for regression, just use latest offset
      const latest = this.timeHistory[this.timeHistory.length - 1]!;
      this.skewSlope = 1;
      this.skewIntercept = latest.realTime - latest.localHighRes;
      return;
    }

    // Linear Regression: realTime = m * localHighRes + c
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    const n = this.timeHistory.length;

    for (const sample of this.timeHistory) {
      sumX += sample.localHighRes;
      sumY += sample.realTime;
      sumXY += sample.localHighRes * sample.realTime;
      sumX2 += sample.localHighRes * sample.localHighRes;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) {
      this.skewSlope = 1;
      const latest = this.timeHistory[n - 1]!;
      this.skewIntercept = latest.realTime - latest.localHighRes;
      return;
    }

    this.skewSlope = (n * sumXY - sumX * sumY) / denominator;
    this.skewIntercept = (sumY - this.skewSlope * sumX) / n;
  }

  /**
   * Converts NTP timestamp format to JavaScript milliseconds.
   * @param seconds - NTP timestamp seconds
   * @param fraction - NTP timestamp fraction
   * @returns Unix timestamp in milliseconds
   */
  public static ntpToMilliseconds(seconds: number, fraction: number): number {
    return (seconds - SEVENTY_YEARS_IN_SECONDS) * 1000 + (fraction * 1000 / 0x100000000);
  }

  /**
   * Gets the current synchronized time.
   * Uses linear regression to extrapolate time between sync events for maximum accuracy.
   * @returns Current NTP time in milliseconds, or 0 if not yet synced
   */
  public getTime(): number {
    if (this.syncStatus !== 'synced' && this.timeHistory.length === 0) {
      return 0; // Time not synced yet
    }
    // realTime = skewSlope * currentHighRes + skewIntercept + userOffset
    return (this.skewSlope * performance.now()) + this.skewIntercept + this.timeOffset;
  }

  /**
   * Gets the current synchronization status.
   * @returns Current status: 'syncing', 'synced', or 'error'
   */
  public getSyncStatus(): SyncStatus {
    return this.syncStatus;
  }

  /**
   * Sets an additional time offset to be applied to all time calculations.
   * @param offset - Time offset in milliseconds
   * @throws {Error} If offset is not a finite number
   */
  public setTimeOffset(offset: number): void {
    if (!Number.isFinite(offset)) {
      throw new Error('Time offset must be a finite number');
    }
    this.timeOffset = offset;
  }

  /**
   * Updates the interval between automatic time synchronizations.
   * @param interval - New interval in milliseconds
   * @throws {Error} If interval is not greater than 0
   */
  public setUpdateInterval(interval: number): void {
    if (interval <= 0) {
      throw new Error('Update interval must be greater than 0');
    }
    this.updateInterval = interval;
    if (this.interval) {
      this.startInterval();
    }
  }

  /**
   * Stops the NTP client and releases all resources.
   * Clears all pending requests, intervals, and closes the UDP socket.
   */
  public stop(): void {
    this.stopInterval();
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingRequests.clear();
    this.udp.close();
  }

  private setSyncStatus(status: SyncStatus): void {
    this.syncStatus = status;
    this.emit(NTP_EVENTS.SYNC_STATUS, this.syncStatus);
  }

  private handleError(message: string, error: Error): void {
    error.message = `${message}: ${error.message}`;
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