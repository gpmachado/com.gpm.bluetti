'use strict';

const Homey = require('homey');

class PowerStationDriver extends Homey.Driver {

  async onInit() {
    this.log('Power Station driver initialized');
  }

  get cloud() {
    return this.homey.app.cloud;
  }

  // Shows the BLUETTI login page and stores the token once the user signs in.
  async _startOAuth(session, onAuthorized) {
    const oAuth2Callback = await this.homey.cloud.createOAuth2Callback(this.cloud.buildAuthorizeUrl());
    oAuth2Callback
      .on('url', (url) => {
        session.emit('url', url).catch(this.error);
      })
      .on('code', async (code) => {
        try {
          if (code instanceof Error) throw code;
          await this.cloud.exchangeCode(code);
          if (onAuthorized) await onAuthorized();
          session.emit('authorized').catch(this.error);
        } catch (err) {
          this.error('BLUETTI login failed:', err.message);
          session.emit('error', err.message || String(err)).catch(this.error);
        }
      });
  }

  async onPair(session) {
    session.setHandler('showView', async (viewId) => {
      if (viewId !== 'login_oauth2') return;

      // Reuse an existing login when adding a second power station.
      if (this.cloud.hasToken()) {
        try {
          await this.cloud.getDevices();
          await session.nextView();
          return;
        } catch (err) {
          this.log('Stored BLUETTI login is not usable, asking to sign in again:', err.message);
        }
      }

      try {
        await this._startOAuth(session);
      } catch (err) {
        this.error(err);
        session.emit('error', err.message || String(err)).catch(this.error);
      }
    });

    session.setHandler('list_devices', async () => {
      const products = await this.cloud.getDevices();
      this.log(`BLUETTI account has ${products.length} device(s)`);
      return products.map((product) => ({
        name: product.name || product.model || `BLUETTI ${product.sn}`,
        data: { id: product.sn },
        store: { model: product.model || null },
        settings: { sn: String(product.sn), model: product.model || '' },
      }));
    });
  }

  async onRepair(session, device) {
    session.setHandler('showView', async (viewId) => {
      if (viewId !== 'login_oauth2') return;
      try {
        await this._startOAuth(session, async () => device.restartPolling());
      } catch (err) {
        this.error(err);
        session.emit('error', err.message || String(err)).catch(this.error);
      }
    });
  }

}

module.exports = PowerStationDriver;
