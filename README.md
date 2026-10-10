# BLUETTI for Homey

Community Homey app to monitor and control BLUETTI power stations through the BLUETTI cloud.
Not affiliated with or supported by BLUETTI.

**Tested with: BLUETTI Elite 30 V2 only.** Other models supported by the BLUETTI cloud may work but are untested —
reports (including any `Unmapped fnCode` log lines) are welcome.

**Install (test version):** https://homey.app/a/com.gpm.bluetti/test/

**Community topic (questions, reports for other models):** https://community.homey.app/t/app-pro-bluetti-power-stations-via-bluetti-cloud/160644

See [README.txt](README.txt) for features and setup.

## How it works

BLUETTI power stations expose no local network API (all TCP ports closed), so the app uses the
BLUETTI cloud API used by the official Home Assistant integration:

- OAuth2 login at `sso.bluettipower.com` (via Homey's OAuth2 callback)
- `GET /api/bluiotdata/ha/v1/deviceStates` for values, `POST /ha/v1/fulfillment` for control
- STOMP over WebSocket (`/api/edgeiotgw/ws-coordination/websocket`) for real-time change notifications

## Credits

- [bluetti-official/bluetti-home-assistant](https://github.com/bluetti-official/bluetti-home-assistant) — MIT, © 2025 Bluetti: API endpoints, OAuth client, real-time protocol, work-mode codes
- [Percy2Live/ioBroker.bluetti](https://github.com/Percy2Live/ioBroker.bluetti) — MIT: verified Elite 30 V2 payload and OAuth details
- [ws](https://github.com/websockets/ws) — MIT: WebSocket client (runtime dependency)

## License

MIT
