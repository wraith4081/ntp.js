import NTPClient, { NTP_EVENTS } from '../src/index';
import dgram from 'dgram';
import dns from 'dns';

jest.mock('dgram');
jest.mock('dns');

// Mock perf_hooks
jest.mock('perf_hooks', () => ({
	performance: {
		now: jest.fn(),
	},
}));

import { performance } from 'perf_hooks';

describe('NTPClient', () => {
	let ntpClient: NTPClient;
	let mockSocket: any;
	// mockPerformanceNow will be the mock function from the module
	const mockPerformanceNow = performance.now as jest.Mock;

	beforeEach(() => {
		jest.useFakeTimers();
		mockSocket = {
			on: jest.fn(),
			bind: jest.fn((port: number, cb?: () => void) => { if (cb) cb(); }),
			send: jest.fn(),
			close: jest.fn(),
			removeAllListeners: jest.fn(),
		};
		(dgram.createSocket as jest.Mock).mockReturnValue(mockSocket);
		(dns.lookup as unknown as jest.Mock).mockImplementation((hostname, options, cb) => {
			cb(null, '1.2.3.4', 4);
		});

		// Reset mock return value
		mockPerformanceNow.mockReset();

		ntpClient = new NTPClient();
	});

	afterEach(() => {
		jest.clearAllMocks();
		jest.useRealTimers();
	});

	test('constructor initializes with default values', () => {
		expect(ntpClient['poolServerName']).toBe('pool.ntp.org');
		expect(ntpClient['port']).toBe(123);
		expect(ntpClient['timeOffset']).toBe(0);
		expect(ntpClient['updateInterval']).toBe(60000);
		expect(ntpClient['maxRetries']).toBe(3);
		expect(ntpClient['rttThreshold']).toBe(250);
	});

	test('constructor throws error for invalid port', () => {
		expect(() => new NTPClient({ port: 0 })).toThrow('Port must be between 1 and 65535');
		expect(() => new NTPClient({ port: 70000 })).toThrow('Port must be between 1 and 65535');
	});

	test('constructor throws error for invalid updateInterval', () => {
		expect(() => new NTPClient({ updateInterval: 0 })).toThrow('Update interval must be greater than 0');
		expect(() => new NTPClient({ updateInterval: -100 })).toThrow('Update interval must be greater than 0');
	});

	test('constructor throws error for invalid maxRetries', () => {
		expect(() => new NTPClient({ maxRetries: -1 })).toThrow('Max retries must be non-negative');
	});

	test('constructor throws error for invalid rttThreshold', () => {
		expect(() => new NTPClient({ rttThreshold: 0 })).toThrow('RTT threshold must be greater than 0');
		expect(() => new NTPClient({ rttThreshold: -100 })).toThrow('RTT threshold must be greater than 0');
	});

	test('constructor accepts custom rttThreshold', () => {
		const client = new NTPClient({ rttThreshold: 500 });
		expect(client['rttThreshold']).toBe(500);
	});

	test('forceUpdate() sends NTP packet with local T1 storage (including fraction)', async () => {
		const now = 1000;
		const nowHighRes = 100.5;
		jest.spyOn(Date, 'now').mockReturnValue(now);
		mockPerformanceNow.mockReturnValue(nowHighRes);
		// Mock Math.random to return 0 for deterministic ID
		jest.spyOn(Math, 'random').mockReturnValue(0);

		await ntpClient.forceUpdate();

		// Calculate expected ID
		const ntpSec = Math.floor(now / 1000 + 2208988800);
		// With random = 0, fuzz is 0.
		const ntpFrac = Math.floor(((now % 1000) / 1000) * 0x100000000);
		const packetID = `${ntpSec}:${ntpFrac}`;

		expect(ntpClient['pendingRequests'].size).toBe(1);
		expect(ntpClient['pendingRequests'].get(packetID)).toEqual(expect.objectContaining({ highRes: nowHighRes, unix: now }));
		expect(ntpClient['pendingRequests'].get(packetID)!.timeoutId).toBeDefined();
		expect(mockSocket.send).toHaveBeenCalled();

		// Verify buffer content (seconds and fraction)
		const sentBuffer = mockSocket.send.mock.calls[0][0];
		expect(sentBuffer.readUInt32BE(40)).toBe(ntpSec);
		expect(sentBuffer.readUInt32BE(44)).toBe(ntpFrac);
	});

	test('processNTPPacket() calculates time using high-res and stores history', () => {
		// Setup pending request
		const T1_unix = 1600000000000;
		const T1_highRes = 1000;
		const ntpSec = Math.floor(T1_unix / 1000 + 2208988800);
		const ntpFrac = Math.floor(((T1_unix % 1000) / 1000) * 0x100000000);
		const packetID = `${ntpSec}:${ntpFrac}`;

		ntpClient['pendingRequests'].set(packetID, { highRes: T1_highRes, unix: T1_unix, timeoutId: setTimeout(() => { }, 1000) });

		// Mock performance.now() for receive time (T4)
		mockPerformanceNow.mockReturnValue(1100); // 100ms local elapsed

		const mockBuffer = Buffer.alloc(48);

		// T2 = Server Receive = T1_unix + 20ms
		const T2 = T1_unix + 20;
		// T3 = Server Transmit = T2 + 10ms processing
		const T3 = T2 + 10;

		// Write timestamps to packet
		// Origin T1 (Client sent time) -> Server echos this back
		mockBuffer.writeUInt8(4, 0); // Mode 4 (Server)
		mockBuffer.writeUInt8(2, 1); // Stratum 2
		mockBuffer.writeUInt32BE(ntpSec, 24);
		mockBuffer.writeUInt32BE(ntpFrac, 28);

		// Receive T2
		mockBuffer.writeUInt32BE(Math.floor(T2 / 1000) + 2208988800, 32);
		mockBuffer.writeUInt32BE(Math.floor((T2 % 1000) / 1000 * 0x100000000), 36);
		// Transmit T3
		mockBuffer.writeUInt32BE(Math.floor(T3 / 1000) + 2208988800, 40);
		mockBuffer.writeUInt32BE(Math.floor((T3 % 1000) / 1000 * 0x100000000), 44);

		ntpClient['processNTPPacket'](mockBuffer);

		expect(ntpClient['roundTripDelay']).toBeCloseTo(90, 0);

		// Check history
		const history = ntpClient['timeHistory'];
		expect(history.length).toBe(1);
		expect(history[0]!.localHighRes).toBe(1100);
		expect(history[0]!.realTime).toBeCloseTo(T3 + 45, 0);

		// Map should be cleared
		expect(ntpClient['pendingRequests'].size).toBe(0);
	});

	test('processNTPPacket() filters outliers (>250ms)', () => {
		// Setup pending request
		const T1_unix = 1600000000000;
		const T1_highRes = 1000;
		const ntpSec = Math.floor(T1_unix / 1000 + 2208988800);
		const ntpFrac = Math.floor(((T1_unix % 1000) / 1000) * 0x100000000);
		const packetID = `${ntpSec}:${ntpFrac}`;

		ntpClient['pendingRequests'].set(packetID, { highRes: T1_highRes, unix: T1_unix, timeoutId: setTimeout(() => { }, 1000) });

		// Mock performance.now() for receive time (T4)
		// Simulate 300ms RTT
		// T1 = 1000
		// T4 = 1300 (Local elapsed 300ms)
		mockPerformanceNow.mockReturnValue(1300);

		const mockBuffer = Buffer.alloc(48);

		// T2 = Server Receive = T1 + 10ms
		const T2 = T1_unix + 10;
		// T3 = Server Transmit = T2 + 10ms processing
		const T3 = T2 + 10;

		// Write timestamps to packet
		mockBuffer.writeUInt8(4, 0); // Mode 4
		mockBuffer.writeUInt8(2, 1); // Stratum 2
		mockBuffer.writeUInt32BE(ntpSec, 24);
		mockBuffer.writeUInt32BE(ntpFrac, 28);

		// Receive T2
		mockBuffer.writeUInt32BE(Math.floor(T2 / 1000) + 2208988800, 32);
		mockBuffer.writeUInt32BE(Math.floor((T2 % 1000) / 1000 * 0x100000000), 36);
		// Transmit T3
		mockBuffer.writeUInt32BE(Math.floor(T3 / 1000) + 2208988800, 40);
		mockBuffer.writeUInt32BE(Math.floor((T3 % 1000) / 1000 * 0x100000000), 44);

		ntpClient['processNTPPacket'](mockBuffer);

		// RTT = (1300 - 1000) - (T3 - T2) = 300 - 10 = 290ms
		// It is > 250ms, so it should be filtered OUT.

		expect(ntpClient['roundTripDelay']).toBeCloseTo(290, 0);

		// Check history - should be EMPTY
		const history = ntpClient['timeHistory'];
		expect(history.length).toBe(0);
		// Map should be cleared even if filtered
		expect(ntpClient['pendingRequests'].size).toBe(0);
	});

	test('processNTPPacket() handles interleaved packets correctly', () => {
		// Req A: T1=1000
		const TA_unix = 1600000000000;
		const TA_highRes = 1000;
		const idA = `${Math.floor(TA_unix / 1000 + 2208988800)}:${Math.floor(((TA_unix % 1000) / 1000) * 0x100000000)}`;

		// Req B: T1=1500 (sent 500ms later)
		const TB_unix = 1600000000500;
		const TB_highRes = 1500;
		const idB = `${Math.floor(TB_unix / 1000 + 2208988800)}:${Math.floor(((TB_unix % 1000) / 1000) * 0x100000000)}`;

		ntpClient['pendingRequests'].set(idA, { highRes: TA_highRes, unix: TA_unix, timeoutId: setTimeout(() => { }, 1000) });
		ntpClient['pendingRequests'].set(idB, { highRes: TB_highRes, unix: TB_unix, timeoutId: setTimeout(() => { }, 1000) });

		// Packet for A arrives LATER (at 2000)
		mockPerformanceNow.mockReturnValue(2000);

		const bufferA = Buffer.alloc(48);
		// Write ID A into buffer (Origin Timestamp)
		bufferA.writeUInt8(4, 0); // Mode 4
		bufferA.writeUInt8(2, 1); // Stratum 2
		bufferA.writeUInt32BE(Math.floor(TA_unix / 1000) + 2208988800, 24);
		bufferA.writeUInt32BE(Math.floor(((TA_unix % 1000) / 1000) * 0x100000000), 28);

		// Fill dummy T2/T3 for A
		const T2A = TA_unix + 10;
		const T3A = T2A + 10;
		bufferA.writeUInt32BE(Math.floor(T2A / 1000) + 2208988800, 32);
		bufferA.writeUInt32BE(Math.floor((T2A % 1000) / 1000 * 0x100000000), 36);
		bufferA.writeUInt32BE(Math.floor(T3A / 1000) + 2208988800, 40);
		bufferA.writeUInt32BE(Math.floor((T3A % 1000) / 1000 * 0x100000000), 44);

		ntpClient['processNTPPacket'](bufferA);

		// Should have processed A correctly
		// Local elapsed = 2000 - 1000 = 1000ms
		// Server proc = 10ms
		// RTT = 990ms (Filtered out as outlier? > 250ms. Wait.)
		// RTT 990ms is definitely > 250ms. So it will be filtered from HISTORY.
		// But delay calculation should still happen.

		expect(ntpClient['roundTripDelay']).toBeCloseTo(990, 0);
		expect(ntpClient['pendingRequests'].has(idA)).toBe(false);
		expect(ntpClient['pendingRequests'].has(idB)).toBe(true); // B still pending

		// History should be empty because 990ms > 250ms
		expect(ntpClient['timeHistory'].length).toBe(0);
	});

	test('recalculateSkew() computes linear regression correctly', () => {
		// Add samples: realTime = 2 * localHighRes + 100
		// History: (10, 120), (20, 140), (30, 160)
		ntpClient['addTimeSample'](10, 120);
		ntpClient['addTimeSample'](20, 140);
		ntpClient['addTimeSample'](30, 160);

		ntpClient['recalculateSkew']();

		expect(ntpClient['skewSlope']).toBeCloseTo(2.0, 5);
		expect(ntpClient['skewIntercept']).toBeCloseTo(100, 5);
	});

	test('getTime() returns correct extrapolated time', () => {
		ntpClient['syncStatus'] = 'synced';
		ntpClient['skewSlope'] = 1.0;
		ntpClient['skewIntercept'] = 1000000;

		mockPerformanceNow.mockReturnValue(500); // current high res
		// Time = 1.0 * 500 + 1000000 = 1000500
		expect(ntpClient.getTime()).toBe(1000500);

		// With user offset
		ntpClient.setTimeOffset(100);
		expect(ntpClient.getTime()).toBe(1000600);
	});

	test('getTime() returns 0 if not synced', () => {
		expect(ntpClient.getTime()).toBe(0);
	});

	test('setTimeOffset() throws error for invalid values', () => {
		expect(() => ntpClient.setTimeOffset(NaN)).toThrow('Time offset must be a finite number');
		expect(() => ntpClient.setTimeOffset(Infinity)).toThrow('Time offset must be a finite number');
		expect(() => ntpClient.setTimeOffset(-Infinity)).toThrow('Time offset must be a finite number');
	});

	test('setUpdateInterval() throws error for invalid values', () => {
		expect(() => ntpClient.setUpdateInterval(0)).toThrow('Update interval must be greater than 0');
		expect(() => ntpClient.setUpdateInterval(-100)).toThrow('Update interval must be greater than 0');
	});

	test('processNTPPacket() validates Mode (must be 4)', () => {
		const T1_unix = 1600000000000;
		const ntpSec = Math.floor(T1_unix / 1000 + 2208988800);
		const ntpFrac = Math.floor(((T1_unix % 1000) / 1000) * 0x100000000);
		const packetID = `${ntpSec}:${ntpFrac}`;
		ntpClient['pendingRequests'].set(packetID, { highRes: 1000, unix: T1_unix, timeoutId: setTimeout(() => { }, 1000) });

		const mockBuffer = Buffer.alloc(48);
		mockBuffer.writeUInt8(3, 0); // Mode 3 (Client) - Invalid for response
		mockBuffer.writeUInt8(4, 1); // Stratum 4 - Valid
		mockBuffer.writeUInt32BE(ntpSec, 24);
		mockBuffer.writeUInt32BE(ntpFrac, 28);

		ntpClient['processNTPPacket'](mockBuffer);

		// Should NOT process
		expect(ntpClient['pendingRequests'].has(packetID)).toBe(true);
	});

	test('processNTPPacket() validates Stratum (rejects 0 and 16)', () => {
		const T1_unix = 1600000000000;
		const ntpSec = Math.floor(T1_unix / 1000 + 2208988800);
		const ntpFrac = Math.floor(((T1_unix % 1000) / 1000) * 0x100000000);
		const packetID = `${ntpSec}:${ntpFrac}`;
		const addRequest = () => ntpClient['pendingRequests'].set(packetID, { highRes: 1000, unix: T1_unix, timeoutId: setTimeout(() => { }, 1000) });

		addRequest();
		const mockBuffer0 = Buffer.alloc(48);
		mockBuffer0.writeUInt8(4 | (4 << 3), 0); // Mode 4
		mockBuffer0.writeUInt8(0, 1); // Stratum 0 (KoD) - Invalid
		mockBuffer0.writeUInt32BE(ntpSec, 24);
		mockBuffer0.writeUInt32BE(ntpFrac, 28);

		ntpClient['processNTPPacket'](mockBuffer0);
		expect(ntpClient['pendingRequests'].has(packetID)).toBe(true); // Ignored

		// Cleanup for next check
		ntpClient['pendingRequests'].delete(packetID);
		addRequest();

		const mockBuffer16 = Buffer.alloc(48);
		mockBuffer16.writeUInt8(4 | (4 << 3), 0); // Mode 4
		mockBuffer16.writeUInt8(16, 1); // Stratum 16 (Unsynced) - Invalid
		mockBuffer16.writeUInt32BE(ntpSec, 24);
		mockBuffer16.writeUInt32BE(ntpFrac, 28);

		ntpClient['processNTPPacket'](mockBuffer16);
		expect(ntpClient['pendingRequests'].has(packetID)).toBe(true); // Ignored
	});

	test('processNTPPacket() validates Origin Timestamp', () => {
		const T1_unix = 1600000000000;
		const ntpSec = Math.floor(T1_unix / 1000 + 2208988800);
		const ntpFrac = Math.floor(((T1_unix % 1000) / 1000) * 0x100000000);
		const packetID = `${ntpSec}:${ntpFrac}`;
		ntpClient['pendingRequests'].set(packetID, { highRes: 1000, unix: T1_unix, timeoutId: setTimeout(() => { }, 1000) });

		const mockBuffer = Buffer.alloc(48);
		mockBuffer.writeUInt8(4 | (4 << 3), 0); // Mode 4
		mockBuffer.writeUInt8(2, 1); // Stratum 2
		// Wrong Origin Timestamp
		mockBuffer.writeUInt32BE(ntpSec + 1, 24);
		mockBuffer.writeUInt32BE(ntpFrac, 28);

		ntpClient['processNTPPacket'](mockBuffer);

		// Should NOT process (pending request remains)
		expect(ntpClient['pendingRequests'].has(packetID)).toBe(true);
	});

	test('sendNTPPacket() sets timeout and retries on failure', async () => {
		jest.spyOn(Math, 'random').mockReturnValue(0);
		// jest.useFakeTimers() is already called in beforeEach

		await ntpClient['sendNTPPacket']();

		expect(ntpClient['pendingRequests'].size).toBe(1);
		expect(mockSocket.send).toHaveBeenCalledTimes(1);

		// Fast forward exceeding timeout (3000ms)
		jest.advanceTimersByTime(3001);

		// Should have triggered retry
		// Retry logic: handleReqTimeout -> handleSendError -> setTimeout(1000) -> sendNTPPacket

		// First, handleReqTimeout removes the request
		expect(ntpClient['pendingRequests'].size).toBe(0);

		// Then it calls handleSendError which increments retryCount (was 0, now 1) and sets timeout 1000ms
		expect(ntpClient['retryCount']).toBe(1);

		// Fast forward retry delay (1000ms)
		jest.advanceTimersByTime(1001);

		// Flush promise microtasks
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}

		// Force resolution of macro-tasks (setTimeout) if needed.
		// Since we can't await inside the setTimeout callback easily, we check if it called sendNTPPacket.
		// Actually, sendNTPPacket is async, but setTimeout calls it without await.
		// So it should trigger the call.

		expect(mockSocket.send).toHaveBeenCalledTimes(2);
		expect(ntpClient['pendingRequests'].size).toBe(1);
	});

	test('burstSync() sends multiple packets on begin', async () => {
		jest.useFakeTimers();

		// Mock bind to execute callback immediately
		mockSocket.bind.mockImplementation((port: any, cb: any) => {
			if (cb) cb();
		});

		const forceUpdateSpy = jest.spyOn(ntpClient, 'forceUpdate');
		ntpClient.begin(); // Triggers burstSync

		// Initialization sends first packet immediately
		// await resolved promise to let async flow happen
		await Promise.resolve();
		expect(forceUpdateSpy).toHaveBeenCalledTimes(1);

		// Forward 2000ms
		jest.advanceTimersByTime(2000);
		await Promise.resolve();
		expect(forceUpdateSpy).toHaveBeenCalledTimes(2);

		// Forward 2000ms
		jest.advanceTimersByTime(2000);
		await Promise.resolve();
		expect(forceUpdateSpy).toHaveBeenCalledTimes(3);

		// Forward 2000ms
		jest.advanceTimersByTime(2000);
		await Promise.resolve();
		expect(forceUpdateSpy).toHaveBeenCalledTimes(4);

		// Should stop after 4
		jest.advanceTimersByTime(2000);
		expect(forceUpdateSpy).toHaveBeenCalledTimes(4);
	});

	test('sendNTPPacket uses correct protocol and address from DNS', async () => {
		(dns.lookup as unknown as jest.Mock).mockImplementation((hostname, options, cb) => {
			cb(null, '2001:db8::1', 6);
		});

		await ntpClient.forceUpdate();

		// Expect dgram to be recreated with udp6
		expect(dgram.createSocket).toHaveBeenCalledWith('udp6');
		// socket should have been replaced, so update mockSocket ref if needed but simpler to check send call
		// send is called on this.udp. Since createSocket returned mockSocket, it is the same object mock.

		expect(mockSocket.send).toHaveBeenCalled();
		const callArgs = mockSocket.send.mock.calls[0];
		// buffer, offset, length, port, address, cb
		expect(callArgs[4]).toBe('2001:db8::1');
	});

	test('sendNTPPacket switches protocol if needed', async () => {
		// Start as udp4 (default) using the setup in beforeEach
		// 1. First call with IPv4
		(dns.lookup as unknown as jest.Mock).mockImplementation((hostname, options, cb) => {
			cb(null, '1.2.3.4', 4);
		});

		await ntpClient.forceUpdate();

		expect(dgram.createSocket).toHaveBeenCalledWith('udp4'); // from constructor + default
		expect(mockSocket.send).toHaveBeenCalledTimes(1);
		expect(ntpClient['currentProtocol']).toBe('udp4');

		// 2. Next call with IPv6
		(dns.lookup as unknown as jest.Mock).mockImplementation((hostname, options, cb) => {
			cb(null, '2001:db8::1', 6);
		});

		// Reset mockSocket to verify close is called
		mockSocket.close.mockClear();
		// and createSocket should be called again
		(dgram.createSocket as jest.Mock).mockClear();
		(dgram.createSocket as jest.Mock).mockReturnValue(mockSocket); // Return same mock for simplicity

		await ntpClient.forceUpdate();

		expect(mockSocket.close).toHaveBeenCalled();
		expect(dgram.createSocket).toHaveBeenCalledWith('udp6');
		expect(ntpClient['currentProtocol']).toBe('udp6');
		expect(mockSocket.send).toHaveBeenCalledTimes(2);

		// Check address in second call
		expect(mockSocket.send.mock.calls[1][4]).toBe('2001:db8::1');
	});

	test('dnsLookup handles errors gracefully', async () => {
		(dns.lookup as unknown as jest.Mock).mockImplementation((hostname, options, cb) => {
			cb(new Error('DNS Error'), '', 0);
		});

		const errorHandler = jest.fn();
		ntpClient.on(NTP_EVENTS.ERROR, errorHandler);

		await ntpClient.forceUpdate();

		expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('DNS Lookup failed') }));
	});
});
