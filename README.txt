Monitor and control your BLUETTI power station from Homey, over the network, from anywhere.

This is a community app. It is not made or supported by BLUETTI.

TESTED WITH: BLUETTI Elite 30 V2 only.
Other BLUETTI models that work with the BLUETTI cloud may also work, but they have not been tested. If you try another model, please share your results in the community topic.

What you get
- Battery level
- Solar input, grid input, AC output and DC output power
- Battery power (positive = charging, negative = discharging)
- Time to empty and time to full (e.g. "1d 9h 6m")
- Backup time: how long your current loads would run on battery if the grid failed now. In UPS mode the BLUETTI "time to empty" assumes almost no battery use, so this estimate is the useful number for a UPS. Set your battery capacity (Wh) in the device settings; it is filled in for the Elite 30 V2
- Working mode (Standard UPS, PV Priority UPS, Time Control UPS, Custom UPS)
- AC output, DC output, AC ECO and DC ECO on/off, from the device and from Flows
- Real-time updates: changes made on the power station or in the BLUETTI app show up in Homey within seconds
- Bluetooth fallback (optional): when Wi-Fi or the BLUETTI cloud is down, Homey reads battery level, power and time remaining directly over Bluetooth. Homey must be within Bluetooth range. Turn it on in the device settings.

Flow cards
- When: an output was turned on or off; the power station went offline; came back online
- And: an output is on/off
- Then: turn an output on or off

Requirements
- The power station must already be set up and connected to Wi-Fi with the BLUETTI mobile app.
- A BLUETTI account (the same one you use in the BLUETTI app).
- Internet access: BLUETTI power stations do not offer a local network connection, so Homey talks to them through the BLUETTI cloud. With the Bluetooth fallback on, monitoring keeps working without internet.

Setup
Add a device, choose BLUETTI > Power Station, sign in with your BLUETTI account and select your power station.

Not available
Charging mode, Power Lifting, SOC limits, auto-sleep and display settings are not offered by the BLUETTI cloud for third-party apps, so they cannot be controlled from Homey.
