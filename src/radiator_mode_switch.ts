import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { Technotherm } from './platform';
import { HelkiClient, Status } from './helki_client';
import axios from 'axios';

/**
 * Switch accessory that controls all radiators' mode
 * ON = AUTO mode
 * OFF = MANUAL mode at 17°C
 */
export class RadiatorModeSwitch {
  private service: Service;
  private currentState: boolean = false; // false = MANUAL, true = AUTO
  private isUpdating: boolean = false; // Prevent recursive updates

  constructor(
    private readonly platform: Technotherm,
    private readonly accessory: PlatformAccessory,
    private readonly helkiClient: HelkiClient,
  ) {
    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Technotherm')
      .setCharacteristic(this.platform.Characteristic.Model, 'Radiator Mode Switch')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'RADIATOR-MODE-SWITCH-001');

    // Get or create the Switch service
    this.service = this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch);

    this.service.setCharacteristic(this.platform.Characteristic.Name, 'Radiator Mode');

    // Register handlers
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetOn.bind(this))
      .onGet(this.handleGetOn.bind(this));

    // Initial state check
    this.syncStateFromRadiators().catch(error => {
      this.platform.log.error('Failed to sync initial state from radiators:', error);
    });

    // Periodic state sync
    setInterval(() => {
      this.syncStateFromRadiators().catch(error => {
        this.platform.log.error('Failed to sync state from radiators:', error);
      });
    }, 30000); // Every 30 seconds

    // Sync with Shelly if configured
    const shellyIp = this.platform.config.shellyIp as string | undefined;
    if (shellyIp) {
      setInterval(() => {
        this.syncStateFromShelly(shellyIp).catch(error => {
          this.platform.log.debug('Failed to sync state from Shelly:', error);
        });
      }, 10000); // Every 10 seconds
    }
  }

  /**
   * Handle switch being turned on/off from HomeKit
   */
  private async handleSetOn(value: CharacteristicValue) {
    if (this.isUpdating) {
      return; // Prevent recursive updates
    }

    const targetState = value as boolean;
    this.isUpdating = true;

    try {
      if (targetState) {
        // Switch ON -> Set all radiators to AUTO
        await this.setAllRadiatorsToAuto();
        this.currentState = true;
        this.platform.log.info('HomeKit switch turned ON - Set all radiators to AUTO mode');
      } else {
        // Switch OFF -> Set all radiators to MANUAL at 17°C
        await this.setAllRadiatorsToManual();
        this.currentState = false;
        this.platform.log.info('HomeKit switch turned OFF - Set all radiators to MANUAL mode at 17°C');
      }

      // Also update Shelly switch if configured
      const shellyIp = this.platform.config.shellyIp as string | undefined;
      if (shellyIp) {
        await this.setShellySwitchState(shellyIp, targetState);
      }

      // Update the characteristic to reflect the new state
      this.service.updateCharacteristic(this.platform.Characteristic.On, this.currentState);
    } catch (error) {
      this.platform.log.error('Failed to set radiator mode:', error);
      // Revert the switch state on error
      this.service.updateCharacteristic(this.platform.Characteristic.On, !targetState);
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * Handle HomeKit requesting current switch state
   */
  private async handleGetOn(): Promise<boolean> {
    // Return cached state, but also trigger a background sync
    this.syncStateFromRadiators().catch(error => {
      this.platform.log.debug('Background state sync failed:', error);
    });
    return this.currentState;
  }

  /**
   * Set all radiators to AUTO mode
   */
  private async setAllRadiatorsToAuto(): Promise<void> {
    // Get all radiator accessories (exclude the switch itself)
    const radiatorAccessories = this.platform.accessories.filter(
      acc => acc.context.device && acc.context.node && acc.UUID !== this.accessory.UUID
    );

    const results = await Promise.allSettled(
      radiatorAccessories.map(async (accessory) => {
        const device = accessory.context.device;
        const node = accessory.context.node;
        await this.helkiClient.setStatus(device.dev_id, node, { mode: 'auto' });
        return { name: accessory.displayName, status: 'success' };
      })
    );

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    if (failed > 0) {
      this.platform.log.warn(`Set ${successful} radiators to AUTO mode, ${failed} failed`);
    }
  }

  /**
   * Set all radiators to MANUAL mode at 17°C
   */
  private async setAllRadiatorsToManual(): Promise<void> {
    // Get all radiator accessories (exclude the switch itself)
    const radiatorAccessories = this.platform.accessories.filter(
      acc => acc.context.device && acc.context.node && acc.UUID !== this.accessory.UUID
    );

    const results = await Promise.allSettled(
      radiatorAccessories.map(async (accessory) => {
        const device = accessory.context.device;
        const node = accessory.context.node;
        await this.helkiClient.setStatus(device.dev_id, node, {
          mode: 'manual',
          stemp: '17.0',
          units: 'C',
        });
        return { name: accessory.displayName, status: 'success' };
      })
    );

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    if (failed > 0) {
      this.platform.log.warn(`Set ${successful} radiators to MANUAL mode at 17°C, ${failed} failed`);
    }
  }

  /**
   * Sync switch state from actual radiator states
   * Switch is ON (AUTO) only if MORE than 50% of radiators are in AUTO mode
   * This prevents oscillation when exactly 50% are AUTO
   */
  async syncStateFromRadiators(): Promise<void> {
    if (this.isUpdating) {
      return;
    }

    try {
      // Get all radiator accessories (exclude the switch itself)
      const radiatorAccessories = this.platform.accessories.filter(
        acc => acc.context.device && acc.context.node && acc.UUID !== this.accessory.UUID
      );

      const radiatorStates = await Promise.allSettled(
        radiatorAccessories.map(async (accessory) => {
          const device = accessory.context.device;
          const node = accessory.context.node;
          const status = await this.helkiClient.getStatus(device.dev_id, node);
          return status.mode;
        })
      );

      const modes = radiatorStates
        .filter(r => r.status === 'fulfilled')
        .map(r => (r as PromiseFulfilledResult<string>).value);

      if (modes.length === 0) {
        return; // No radiators to check
      }

      // Count AUTO vs MANUAL modes
      const autoCount = modes.filter(m => m === 'auto' || m === 'modified_auto').length;
      const totalRadiators = modes.length;

      // Determine state: switch is ON only if MORE than 50% are AUTO
      // This prevents oscillation when exactly 50% are AUTO
      const newState = autoCount > (totalRadiators / 2);

      if (newState !== this.currentState) {
        this.currentState = newState;
        this.isUpdating = true;
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.currentState);
        this.isUpdating = false;
        this.platform.log.debug(`Synced switch state from radiators: ${this.currentState ? 'ON (AUTO)' : 'OFF (MANUAL)'}`);
      }
    } catch (error) {
      this.platform.log.debug('Failed to sync state from radiators:', error);
    }
  }

  /**
   * Set Shelly switch state remotely
   */
  private async setShellySwitchState(shellyIp: string, state: boolean): Promise<void> {
    try {
      const shellyUrl = `http://${shellyIp}/rpc/Switch.Set?id=0&on=${state}`;
      await axios.get(shellyUrl, { timeout: 3000 });
      this.platform.log.info(`Set Shelly switch to ${state ? 'ON' : 'OFF'}`);
    } catch (error) {
      this.platform.log.warn(`Failed to set Shelly switch state: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Sync switch state from Shelly switch
   */
  async syncStateFromShelly(shellyIp: string): Promise<void> {
    if (this.isUpdating) {
      return;
    }

    try {
      const shellyUrl = `http://${shellyIp}/rpc/Switch.GetStatus?id=0`;
      const switchResponse = await axios.get(shellyUrl, { timeout: 3000 });
      const switchState = switchResponse.data;
      const isShellyOn = switchState.output === true;

      if (isShellyOn !== this.currentState) {
        this.platform.log.info(`Shelly switch state changed to ${isShellyOn ? 'ON' : 'OFF'}, syncing HomeKit switch`);
        this.currentState = isShellyOn;
        this.isUpdating = true;
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.currentState);
        this.isUpdating = false;
      }
    } catch (error) {
      // Silently fail - Shelly might be unreachable
      if (axios.isAxiosError(error) && error.code !== 'ECONNREFUSED' && error.code !== 'ETIMEDOUT') {
        this.platform.log.debug('Failed to query Shelly switch:', error);
      }
    }
  }

  /**
   * Update switch state (called from HTTP endpoints)
   * This is used when Shelly switch triggers the HTTP endpoints
   */
  async updateState(newState: boolean): Promise<void> {
    if (this.isUpdating) {
      return;
    }

    if (newState !== this.currentState) {
      this.currentState = newState;
      this.isUpdating = true;
      this.service.updateCharacteristic(this.platform.Characteristic.On, this.currentState);
      this.isUpdating = false;
      this.platform.log.info(`Updated HomeKit switch state to ${newState ? 'ON' : 'OFF'} from HTTP endpoint`);
    }
  }
}

