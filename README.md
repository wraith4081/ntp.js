# NTP.JS

<p align="center">
  <a href="https://www.npmjs.com/package/ntp.js"><img src="https://img.shields.io/npm/v/ntp.js.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/ntp.js"><img src="https://img.shields.io/npm/dm/ntp.js.svg" alt="npm downloads"></a>
  <a href="https://github.com/wraith4081/ntp.js/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/ntp.js.svg" alt="license"></a>
  <a href="https://github.com/wraith4081/ntp.js"><img src="https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen.svg" alt="node version"></a>
</p>

A robust **Network Time Protocol (NTP)** client implementation for Node.js applications with high-precision time synchronization and clock drift compensation.

## Features

- **High-precision time sync** using `performance.now()` for sub-millisecond accuracy
- **Clock drift compensation** via linear regression analysis
- **Burst synchronization** on startup for faster initial time lock
- **IPv4/IPv6 support** with automatic protocol detection
- **Outlier filtering** to reject high-latency responses (>250ms RTT)
- **Automatic retry mechanism** with configurable max retries
- **Event-driven architecture** for real-time status updates
- **TypeScript support** with full type definitions

## Installation

```bash
npm install ntp.js
```

```bash
yarn add ntp.js
```

```bash
pnpm add ntp.js
```

## Quick Start

```typescript
import NTPClient, { NTP_EVENTS } from 'ntp.js';

const ntpClient = new NTPClient();

ntpClient.on(NTP_EVENTS.SYNC, (time) => {
  console.log('Synchronized time:', new Date(time));
});

ntpClient.on(NTP_EVENTS.ERROR, (error) => {
  console.error('NTP error:', error);
});

ntpClient.begin();
```

## Usage Examples

### Basic Usage

```typescript
import NTPClient, { NTP_EVENTS } from 'ntp.js';

const ntpClient = new NTPClient({
  poolServerName: 'pool.ntp.org',
  port: 123,
  updateInterval: 60000, // Sync every 1 minute
});

ntpClient.on(NTP_EVENTS.SYNC, (time) => {
  console.log('Time synced:', new Date(time));
});

ntpClient.begin();
```

### Getting Current Time

```typescript
// After sync, get the current NTP time anytime
const currentTime = ntpClient.getTime();
console.log('Current NTP time:', new Date(currentTime));

// Check sync status before using time
if (ntpClient.getSyncStatus() === 'synced') {
  const accurateTime = ntpClient.getTime();
}
```

### Monitoring Sync Status

```typescript
ntpClient.on(NTP_EVENTS.SYNC_STATUS, (status) => {
  // status: 'syncing' | 'synced' | 'error'
  console.log('Sync status changed:', status);
});
```

### Force Immediate Sync

```typescript
// Trigger an immediate time sync
await ntpClient.forceUpdate();
```

### Cleanup

```typescript
// Stop the client and release resources
ntpClient.stop();
```

## API Reference

### Constructor

```typescript
new NTPClient(options?: NTPClientOptions)
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `poolServerName` | `string` | `'pool.ntp.org'` | NTP server hostname |
| `port` | `number` | `123` | NTP server port (1-65535) |
| `timeOffset` | `number` | `0` | Additional time offset in milliseconds |
| `updateInterval` | `number` | `60000` | Time between sync attempts in ms (must be > 0) |
| `maxRetries` | `number` | `3` | Maximum retry attempts per sync cycle (must be ≥ 0) |
| `protocol` | `'udp4' \| 'udp6'` | `'udp4'` | UDP protocol preference (auto-switches based on DNS) |
| `rttThreshold` | `number` | `250` | RTT threshold in ms for outlier filtering (must be > 0) |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `begin()` | `void` | Start the NTP client with burst sync on startup |
| `forceUpdate()` | `Promise<void>` | Force an immediate time synchronization |
| `getTime()` | `number` | Get current synchronized time (returns 0 if not synced) |
| `getSyncStatus()` | `SyncStatus` | Get current sync status: `'syncing'` \| `'synced'` \| `'error'` |
| `setTimeOffset(offset)` | `void` | Set additional time offset in milliseconds |
| `setUpdateInterval(interval)` | `void` | Update the sync interval in milliseconds |
| `stop()` | `void` | Stop the client and close UDP connection |

### Events

Use the `NTP_EVENTS` enum for type-safe event handling:

| Event | Callback Signature | Description |
|-------|-------------------|-------------|
| `NTP_EVENTS.SYNC` | `(time: number) => void` | Emitted when time is successfully synchronized. `time` is the synced timestamp in milliseconds. |
| `NTP_EVENTS.ERROR` | `(error: Error) => void` | Emitted when an error occurs (DNS failure, max retries exceeded, etc.) |
| `NTP_EVENTS.SYNC_STATUS` | `(status: SyncStatus) => void` | Emitted when sync status changes between `'syncing'`, `'synced'`, or `'error'` |

```typescript
// Using NTP_EVENTS enum (recommended)
ntpClient.on(NTP_EVENTS.SYNC, (time) => { /* ... */ });
ntpClient.on(NTP_EVENTS.ERROR, (error) => { /* ... */ });
ntpClient.on(NTP_EVENTS.SYNC_STATUS, (status) => { /* ... */ });

// Using string literals
ntpClient.on('sync', (time) => { /* ... */ });
ntpClient.on('error', (error) => { /* ... */ });
ntpClient.on('syncStatus', (status) => { /* ... */ });
```

## Requirements

- Node.js >= 16.0.0

## License

[MIT](./LICENSE)

## Contributing

Contributions are welcome! Please submit pull requests or open issues on the [GitHub repository](https://github.com/wraith4081/ntp.js).

## Author

**wraith4081** - [GitHub](https://github.com/wraith4081)

### Contributors

- [BarisYilmaz](https://github.com/BarisYilmaz)
