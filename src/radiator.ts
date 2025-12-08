import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { Technotherm } from './platform';
import { HelkiClient, Node, Status } from './helki_client';

export class Radiator {
  private service: Service;
  private node: Node;
  private isUpdating: boolean = false; // Prevent recursive updates

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
    const targetTemperature = status.stemp ? parseFloat(status.stemp) : 0;

    // Update all characteristics immediately
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, currentTemperature);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, targetTemperature);

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
}
