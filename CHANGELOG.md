# ntp.js

## 1.2.0

### Minor Changes

- ### Features

  - **IPv6 support**: Added automatic protocol detection and switching based on DNS resolution
  - **DNS rotation**: Enhanced NTP server pool handling
  - **Configurable RTT threshold**: Added `rttThreshold` option to customize outlier filtering (default: 250ms)
  - **High-precision time sync**: Implemented `performance.now()` for sub-millisecond accuracy
  - **Clock drift compensation**: Added linear regression analysis for continuous time adjustment
  - **Burst synchronization**: Faster initial time lock with 4 packets at 2-second intervals on startup
  - **Automatic retry mechanism**: Configurable max retries with timeout handling

  ### Bug Fixes

  - **Fixed memory leak**: Resolved static event usage issue in `processNTPPacket`
  - **Fixed type mismatch**: `setSyncStatus` now correctly uses literal SyncStatus values
  - **Fixed socket bind race condition**: Protocol switching now properly awaits bind completion
  - **Fixed NTP packet LI bits**: Changed to `0x1B` (LI=0) for proper client requests
  - **Fixed `getTime()` comparison**: Correctly compares against `'synced'` literal
  - **Fixed `forceUpdate` retry logic**: Reset `retryCount` at start of update cycle
  - **Fixed build script**: Removed space in tsup format argument for proper ESM output

  ### Improvements

  - **Input validation**: Added runtime validation to constructor options and setter methods
  - **Protocol compliance**: Strict packet validation (Origin Timestamp, Mode, Stratum checks)
  - **Outlier filtering**: Responses with RTT above threshold are automatically filtered
  - **JSDoc documentation**: Comprehensive documentation for all public methods and interfaces
  - **Code cleanup**: Removed unused enum values and dead code
  - **TypeScript config**: Added explicit `noImplicitAny` for type safety
  - **Updated README**: Enhanced with badges, expanded features, and detailed API reference

## 1.1.2

### Patch Changes

- 71ca965: Try to fix publish script

## 1.1.1

### Patch Changes

- 38349b7: Update package.json and publish workflow

## 1.1.0

### Minor Changes

- a41bdd6: Add Jest and improve NTP timestamp handling
