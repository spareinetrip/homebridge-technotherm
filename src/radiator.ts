import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { Technotherm } from './platform';
import { HelkiClient, Node, Status } from './helki_client';

export class Radiator {
  private service: Service;
  private node: Node;
  private isUpdating: boolean = false; // Prevent recursive updates
  private forcedTo19C: boolean = false; // Track if radiator was forced to 19°C from AUTO switch
  private forcedTo19CTimestamp: number = 0; // Timestamp when forced to 19°C (expires after 60 seconds)

  constructor(
    private readonly platform: Technotherm,
    private readonly accessory: PlatformAccessory,
    private readonly helkiClient: HelkiClient,
  ) {
    this.node = this.accessory.context.node;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Technotherm')
      .setCharacteristic(this.platform.Characteristic.Model, 'TTKS Combination Radiator')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.product_id);

    this.service = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

    this.registerCharacteristics();

    // Initial status fetch
    this.refreshStatus().catch(error => {
      this.platform.log.error('Failed to refresh initial status:', error);
    });

    // Subscribe to real-time updates via Socket.IO for immediate sync
    const deviceId = this.accessory.context.device.dev_id;
    this.helkiClient.subscribeToDeviceUpdates(deviceId, (status: Status) => {
      this.platform.log.debug(`Real-time update received for ${this.accessory.displayName}`);
      this.onDeviceUpdate(status);
    }).catch(error => {
      this.platform.log.warn(`Failed to subscribe to real-time updates for ${this.accessory.displayName}, falling back to polling:`, error);
    });

    // Fallback polling (more frequent for better sync)
    setInterval(() => {
      this.refreshStatus().catch(error => {
        this.platform.log.error('Failed to refresh status:', error);
      });
    }, 10000); // Every 10 seconds (reduced from 15 for faster sync)

    // Periodically enforce 19°C if forced flag is active (every 5 seconds for first minute)
    setInterval(() => {
      if (this.forcedTo19C) {
        const now = Date.now();
        if (now - this.forcedTo19CTimestamp < 60000) {
          const currentTarget = this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).value as number;
          if (currentTarget !== 19.0) {
            this.platform.log.info(`${this.accessory.displayName}: Enforcing 19°C (forced flag active, current: ${currentTarget}°C)`);
            this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, 19.0);
          }
        } else {
          // Force flag expired
          this.forcedTo19C = false;
        }
      }
    }, 5000); // Check every 5 seconds
  }

  private async refreshStatus(): Promise<void> {
    if (this.isUpdating) {
      return; // Prevent recursive updates during manual changes
    }
    
    const deviceId = this.accessory.context.device.dev_id;
    const status = await this.helkiClient.getStatus(deviceId, this.node);
    this.onDeviceUpdate(status);
  }

  onDeviceUpdate(status: Status): void {
    // Always allow updates from Socket.IO (external changes like AUTO mode)
    // The isUpdating flag only prevents recursive updates from our own refreshStatus() calls
    
    const currentTemperature = status.mtemp ? parseFloat(status.mtemp) : 0;
    // Get current target temperature as fallback to avoid setting invalid 0 value
    const currentTargetTemp = this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).value as number;
    let targetTemperature = status.stemp ? parseFloat(status.stemp) : (currentTargetTemp || 1);

    // If radiator was forced to 19°C from AUTO switch, preserve that temperature
    // even if API returns a different value (prevents Socket.IO/polling from overwriting)
    if (this.forcedTo19C && status.mode === 'manual') {
      const now = Date.now();
      // Force flag expires after 60 seconds to allow normal operation
      if (now - this.forcedTo19CTimestamp < 60000) {
        const originalTemp = targetTemperature;
        targetTemperature = 19.0;
        this.platform.log.info(`${this.accessory.displayName}: Preserving 19°C (forced from AUTO switch), ignoring API value ${status.stemp}°C (age: ${Math.round((now - this.forcedTo19CTimestamp) / 1000)}s)`);
      } else {
        // Force flag expired, clear it
        this.forcedTo19C = false;
        this.platform.log.debug(`${this.accessory.displayName}: Force flag expired, using API value ${status.stemp}`);
      }
    } else if (this.forcedTo19C && status.mode !== 'manual') {
      // If forced but not in manual mode, clear the flag
      this.forcedTo19C = false;
      this.platform.log.debug(`${this.accessory.displayName}: Cleared force flag (not in manual mode)`);
    }

    // Update all characteristics immediately
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, currentTemperature);
    
    // Only update TargetTemperature if it's different from current value to avoid triggering unnecessary updates
    // But always update if forced to ensure 19°C is set
    // Ensure targetTemperature is within valid range (1-30) before setting
    if (targetTemperature < 1) {
      this.platform.log.warn(`${this.accessory.displayName}: Invalid target temperature ${targetTemperature}°C, using minimum value 1°C`);
      targetTemperature = 1;
    } else if (targetTemperature > 30) {
      this.platform.log.warn(`${this.accessory.displayName}: Invalid target temperature ${targetTemperature}°C, using maximum value 30°C`);
      targetTemperature = 30;
    }
    
    // Reuse currentTargetTemp already declared above
    if (targetTemperature !== currentTargetTemp || this.forcedTo19C) {
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, targetTemperature);
    }

    switch (status.mode) {
      case 'auto':
      case 'modified_auto':
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetHeatingCoolingState,
          this.platform.Characteristic.TargetHeatingCoolingState.AUTO,
        );
        break;
      case 'manual':
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetHeatingCoolingState,
          this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
        );
        break;
      case 'off':
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetHeatingCoolingState,
          this.platform.Characteristic.TargetHeatingCoolingState.OFF,
        );
        break;
    }

    const currentHeatingCoolingState = status.active
      ? this.platform.Characteristic.CurrentHeatingCoolingState.HEAT
      : this.platform.Characteristic.CurrentHeatingCoolingState.OFF;

    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      currentHeatingCoolingState,
    );
  }

  registerCharacteristics() {
    // Temperatuurbereik
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({
        minValue: 1,
        maxValue: 30,
        minStep: 0.5,
      })
      .onSet(this.setTargetTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    // Current temperature met 0.1°C precisie
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({
        minStep: 0.1,
      });
  }

  async setTargetTemperature(value: CharacteristicValue) {
    if (this.isUpdating) {
      return; // Prevent recursive updates
    }

    this.isUpdating = true;
    const targetTemp = Number(value);
    const stemp = targetTemp.toFixed(1);

    // If forced to 19°C and user is trying to set it to something else, allow override
    // But if they're setting it to 19°C, don't clear the flag (might be from our own update)
    if (this.forcedTo19C && targetTemp !== 19.0) {
      this.forcedTo19C = false;
      this.platform.log.info(`${this.accessory.displayName}: User manually changed temperature from 19°C to ${targetTemp}°C, clearing force flag`);
    } else if (this.forcedTo19C && targetTemp === 19.0) {
      // User is setting to 19°C - this might be from our forced update, so don't clear the flag
      // But also don't prevent the API call in case they really want to set it
      this.platform.log.debug(`${this.accessory.displayName}: Temperature set to 19°C (forced flag active, allowing API call)`);
    }

    try {
      // Optimistically update the characteristic immediately
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, targetTemp);
      
      // Set the status on the device
      await this.helkiClient.setStatus(this.accessory.context.device.dev_id, this.node, {
        stemp: stemp,
        mode: 'manual',
        units: 'C',
      });

      // Refresh to get the actual state (Socket.IO will also update it)
      await this.refreshStatus();
    } catch (error) {
      this.platform.log.error('Failed to set target temperature:', error);
      // Revert on error
      this.refreshStatus().catch(() => {});
    } finally {
      this.isUpdating = false;
    }
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    if (this.isUpdating) {
      return; // Prevent recursive updates
    }

    this.isUpdating = true;
    let mode: 'manual' | 'auto' | 'off';

    if (value === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
      mode = 'manual';
    } else if (value === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
      mode = 'auto';
      // Clear forced flag when switching to AUTO mode
      this.forcedTo19C = false;
    } else {
      mode = 'off';
    }

    try {
      // Optimistically update the characteristic immediately
      this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, value);
      
      // Set the status on the device
      await this.helkiClient.setStatus(this.accessory.context.device.dev_id, this.node, { mode });

      // Refresh to get the actual state (Socket.IO will also update it)
      await this.refreshStatus();
    } catch (error) {
      this.platform.log.error('Failed to set target heating/cooling state:', error);
      // Revert on error
      this.refreshStatus().catch(() => {});
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * Mark this radiator as forced to 19°C from AUTO switch
   * This prevents Socket.IO/polling updates from overwriting the temperature
   * Immediately updates HomeKit to 19°C to prevent any race conditions
   */
  markForcedTo19C(): void {
    this.forcedTo19C = true;
    this.forcedTo19CTimestamp = Date.now();
    // Immediately update HomeKit to 19°C to prevent race conditions with Socket.IO
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, 19.0);
    this.platform.log.info(`${this.accessory.displayName}: Marked as forced to 19°C from AUTO switch, immediately set HomeKit to 19°C`);
  }

  /**
   * Clear the forced to 19°C flag
   */
  clearForcedTo19C(): void {
    if (this.forcedTo19C) {
      this.forcedTo19C = false;
      this.platform.log.debug(`${this.accessory.displayName}: Cleared forced to 19°C flag`);
    }
  }
}
