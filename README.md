# NTP.JS

A robust Network Time Protocol (NTP) client implementation for Node.js applications.

## Features

-   Synchronizes local time with NTP servers
-   Configurable pool server and port
-   Adjustable time offset and update interval
-   Error handling with retry mechanism
-   Event-driven architecture
-   TypeScript support

## Installation

```bash
npm install ntp.js
```

## Usage

```typescript
import NTPClient, { NTP_EVENTS } from 'ntp.js';

const ntpClient = new NTPClient({
	poolServerName: 'pool.ntp.org',
	port: 123,
	updateInterval: 60000, // 1 minute
});

ntpClient.on(NTP_EVENTS.SYNC, (time) => {
	console.log('Time synced:', new Date(time));
});

ntpClient.on(NTP_EVENTS.ERROR, (error) => {
	console.error('NTP error:', error);
});

ntpClient.begin();
```

## API

### Constructor

```typescript
new NTPClient(options?: NTPClientOptions)
```

#### Options

-   `poolServerName`: NTP server hostname (default: 'pool.ntp.org')
-   `port`: NTP server port (default: 123)
-   `timeOffset`: Additional time offset in milliseconds (default: 0)
-   `updateInterval`: Time between sync attempts in milliseconds (default: 60000)
-   `maxRetries`: Maximum number of retry attempts (default: 3)

### Methods

-   `begin()`: Start the NTP client and initiate synchronization
-   `forceUpdate()`: Force an immediate time synchronization
-   `getTime()`: Get the current synchronized time
-   `getSyncStatus()`: Get the current synchronization status
-   `setTimeOffset(offset: number)`: Set a new time offset
-   `setUpdateInterval(interval: number)`: Set a new update interval
-   `stop()`: Stop the NTP client and close the UDP connection

### Events

-   `'sync'`: Emitted when time is successfully synchronized
-   `'error'`: Emitted when an error occurs
-   `'syncStatus'`: Emitted when sync status changes
-   `'synced'`: Emitted when time is synced
-   `'syncing'`: Emitted when sync process starts

## License

MIT

## Contributing

Contributions are welcome! Please submit pull requests or open issues on the GitHub repository.

## Author

wraith4081
