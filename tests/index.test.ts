import NTPClient, { NTP_EVENTS } from '../src/index';
import dgram from 'dgram';

jest.mock('dgram');

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
			bind: jest.fn(),
			send: jest.fn(),
			close: jest.fn(),
		};
		(dgram.createSocket as jest.Mock).mockReturnValue(mockSocket);

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
	});

	test('forceUpdate() sends NTP packet with local T1 storage (including fraction)', () => {
		const now = 1000;
		const nowHighRes = 100.5;
		jest.spyOn(Date, 'now').mockReturnValue(now);
		mockPerformanceNow.mockReturnValue(nowHighRes);
		// Mock Math.random to return 0 for deterministic ID
		jest.spyOn(Math, 'random').mockReturnValue(0);

		ntpClient.forceUpdate();

		// Calculate expected ID
		const ntpSec = Math.floor(now / 1000 + 2208988800);
		// With random = 0, fuzz is 0.
		const ntpFrac = Math.floor(((now % 1000) / 1000) * 0x100000000);
		const packetID = `${ntpSec}:${ntpFrac}`;

		expect(ntpClient['pendingRequests'].size).toBe(1);
		expect(ntpClient['pendingRequests'].get(packetID)).toEqual({ highRes: nowHighRes, unix: now });
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

		ntpClient['pendingRequests'].set(packetID, { highRes: T1_highRes, unix: T1_unix });

		// Mock performance.now() for receive time (T4)
		mockPerformanceNow.mockReturnValue(1100); // 100ms local elapsed

		const mockBuffer = Buffer.alloc(48);

		// T2 = Server Receive = T1_unix + 20ms
		const T2 = T1_unix + 20;
		// T3 = Server Transmit = T2 + 10ms processing
		const T3 = T2 + 10;

		// Write timestamps to packet
		// Origin T1 (Client sent time) -> Server echos this back
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

		ntpClient['pendingRequests'].set(packetID, { highRes: T1_highRes, unix: T1_unix });

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

		ntpClient['pendingRequests'].set(idA, { highRes: TA_highRes, unix: TA_unix });
		ntpClient['pendingRequests'].set(idB, { highRes: TB_highRes, unix: TB_unix });

		// Packet for A arrives LATER (at 2000)
		mockPerformanceNow.mockReturnValue(2000);

		const bufferA = Buffer.alloc(48);
		// Write ID A into buffer (Origin Timestamp)
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
});
