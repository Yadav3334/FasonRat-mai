# HVNC Implementation Tasks

## Backend
- [ ] Add HVNC channels to REALTIME_COMMANDS in socket.ts
- [ ] Add admin hvnc:subscribe/unsubscribe handlers
- [ ] Add device HVNC socket handlers (status, answer, ICE relay)
- [ ] Add hvnc:stopped emission on disconnect

## Frontend — Types & Constants
- [ ] Add HVNC CMD constants to types/index.ts
- [ ] Add device:hvnc permission type + arrays + groups

## Frontend — Socket Service
- [ ] Add HVNC socket event listeners and subscription functions

## Frontend — Navigation & Routing
- [ ] Add HVNC tab to navigation.ts
- [ ] Add HVNC route to App.tsx

## Frontend — HVNC Page
- [ ] Create Hvnc.tsx with full WebRTC viewer and controls
