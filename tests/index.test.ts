import NTPClient, { NTP_EVENTS } from '../src/index';
import dgram from 'dgram';

jest.mock('dgram');

describe('NTPClient', () => {
	let ntpClient: NTPClient;
	let mockSocket: any;

	beforeEach(() => {
		jest.useFakeTimers();
		mockSocket = {
			on: jest.fn(),
			bind: jest.fn(),
			send: jest.fn(),
			close: jest.fn(),
		};
		(dgram.createSocket as jest.Mock).mockReturnValue(mockSocket);
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

	test('begin() sets up UDP and starts interval', () => {
		ntpClient.begin();
		expect(mockSocket.bind).toHaveBeenCalled();
	});

	test('forceUpdate() sends NTP packet', () => {
		ntpClient.forceUpdate();
		expect(mockSocket.send).toHaveBeenCalled();
	});

	test('getTime() returns 0 when not synced', () => {
		expect(ntpClient.getTime()).toBe(0);
	});

	test('setTimeOffset() updates timeOffset', () => {
		ntpClient.setTimeOffset(1000);
		expect(ntpClient['timeOffset']).toBe(1000);
	});

	test('setUpdateInterval() updates interval', () => {
		ntpClient.setUpdateInterval(30000);
		expect(ntpClient['updateInterval']).toBe(30000);
	});

	test('stop() closes UDP connection', () => {
		ntpClient.stop();
		expect(mockSocket.close).toHaveBeenCalled();
	});

	test('begin() calls forceUpdate immediately when UDP is already setup', () => {
		const forceUpdateSpy = jest.spyOn(ntpClient, 'forceUpdate');
		const startIntervalSpy = jest.spyOn(ntpClient as any, 'startInterval');

		ntpClient['udpSetup'] = true;
		ntpClient.begin();

		expect(mockSocket.bind).not.toHaveBeenCalled();
		expect(startIntervalSpy).toHaveBeenCalled();
		expect(forceUpdateSpy).toHaveBeenCalled();
	});

	test('forceUpdate() resets retry count and updates last sync time', () => {
		const now = Date.now();
		jest.spyOn(Date, 'now').mockReturnValue(now);
		ntpClient.forceUpdate();
		expect(ntpClient['retryCount']).toBe(0);
		expect(ntpClient['lastSyncTime']).toBe(now);
	});

	test('setTimeOffset() updates synced time when already synced', () => {
		ntpClient['syncStatus'] = 'synced';
		ntpClient['syncedTime'] = 1000;
		ntpClient.setTimeOffset(500);
		expect(ntpClient['timeOffset']).toBe(500);
		expect(ntpClient['syncedTime']).toBe(1500);
	});

	test('handleSendError() retries sending NTP packet', () => {
		const sendNTPPacketSpy = jest.spyOn(ntpClient as any, 'sendNTPPacket');
		ntpClient['handleSendError']();
		jest.advanceTimersByTime(1000);
		expect(sendNTPPacketSpy).toHaveBeenCalled();
	});

	test('handleSendError() emits error after max retries', () => {
		const errorListener = jest.fn();
		ntpClient.on(NTP_EVENTS.ERROR, errorListener);
		(ntpClient as any).maxRetries = 3;

		for (let i = 0; i < 4; i++) {
			ntpClient['handleSendError']();
			jest.advanceTimersByTime(1000);
		}

		expect(errorListener).toHaveBeenCalledWith(expect.any(Error));
		expect(ntpClient['syncStatus']).toBe('error');
	});

	test('processNTPPacket() calculates time correctly', () => {
		const mockBuffer = Buffer.alloc(48);
		const now = Date.now();
		jest.spyOn(Date, 'now').mockReturnValue(now);

		const originateTime = now - 200;
		const serverReceiveTime = now - 150;
		const serverTransmitTime = now - 50;

		// Set originate timestamp (T1)
		mockBuffer.writeUInt32BE(Math.floor(originateTime / 1000) + 2208988800, 24);
		mockBuffer.writeUInt32BE(Math.floor((originateTime % 1000) / 1000 * 0x100000000), 28);

		// Set receive timestamp (T2)
		mockBuffer.writeUInt32BE(Math.floor(serverReceiveTime / 1000) + 2208988800, 32);
		mockBuffer.writeUInt32BE(Math.floor((serverReceiveTime % 1000) / 1000 * 0x100000000), 36);

		// Set transmit timestamp (T3)
		mockBuffer.writeUInt32BE(Math.floor(serverTransmitTime / 1000) + 2208988800, 40);
		mockBuffer.writeUInt32BE(Math.floor((serverTransmitTime % 1000) / 1000 * 0x100000000), 44);

		ntpClient['lastSyncTime'] = originateTime;
		ntpClient['processNTPPacket'](mockBuffer);

		expect(ntpClient['roundTripDelay']).toBeCloseTo(100, -2);
		expect(ntpClient['localClockOffset']).toBeCloseTo(-25, -2);
		expect(ntpClient['syncedTime']).toBeCloseTo(now - 25, -2);
		expect(ntpClient['syncStatus']).toBe('synced');
	});

	test('getTime() returns 0 when not synced', () => {
		ntpClient['syncStatus'] = 'syncing';
		expect(ntpClient.getTime()).toBe(0);
	});

	test('getTime() returns correct time when synced', () => {
		const now = Date.now();
		jest.spyOn(Date, 'now').mockReturnValue(now);
		ntpClient['syncStatus'] = 'synced';
		ntpClient['syncedTime'] = now - 1000;
		ntpClient['lastSyncTime'] = now - 2000;
		expect(ntpClient.getTime()).toBe(now - 1000 + 2000);
	});

	test('getSyncStatus() returns current sync status', () => {
		ntpClient['syncStatus'] = 'syncing';
		expect(ntpClient.getSyncStatus()).toBe('syncing');
	});

	test('stop() clears interval and closes UDP connection', () => {
		const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
		ntpClient['interval'] = setInterval(() => { }, 1000) as NodeJS.Timeout;
		ntpClient.stop();
		expect(clearIntervalSpy).toHaveBeenCalled();
		expect(mockSocket.close).toHaveBeenCalled();
	});

	test('emits sync event with correct time', () => {
		const syncListener = jest.fn();
		ntpClient.on(NTP_EVENTS.SYNC, syncListener);
		ntpClient['syncedTime'] = 1000;
		ntpClient['syncStatus'] = 'synced';
		ntpClient['processNTPPacket'](Buffer.alloc(48));
		expect(syncListener).toHaveBeenCalledWith(expect.any(Number));
	});

	test('emits syncStatus event when status changes', () => {
		const syncStatusListener = jest.fn();
		ntpClient.on(NTP_EVENTS.SYNC_STATUS, syncStatusListener);
		ntpClient['setSyncStatus']('syncing');
		expect(syncStatusListener).toHaveBeenCalledWith('syncing');
	});
});
