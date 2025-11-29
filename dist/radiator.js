"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Radiator = void 0;
class Radiator {
    constructor(platform, accessory, helkiClient) {
        this.platform = platform;
        this.accessory = accessory;
        this.helkiClient = helkiClient;
        this.node = this.accessory.context.node;
        this.accessory.getService(this.platform.Service.AccessoryInformation)
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Technotherm')
            .setCharacteristic(this.platform.Characteristic.Model, 'TTKS Combination Radiator')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.product_id);
        this.service = this.accessory.getService(this.platform.Service.Thermostat) ||
            this.accessory.addService(this.platform.Service.Thermostat);
        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
        this.registerCharacteristics();
        // Initieel ophalen + periodieke refresh per radiator
        this.refreshStatus().catch(error => {
            this.platform.log.error('Failed to refresh initial status:', error);
        });
        setInterval(() => {
            this.refreshStatus().catch(error => {
                this.platform.log.error('Failed to refresh status:', error);
            });
        }, 15000); // elke 60 seconden
    }
    async refreshStatus() {
        const deviceId = this.accessory.context.device.dev_id;
        const status = await this.helkiClient.getStatus(deviceId, this.node);
        this.onDeviceUpdate(status);
    }
    onDeviceUpdate(status) {
        const currentTemperature = status.mtemp ? parseFloat(status.mtemp) : 0;
        const targetTemperature = status.stemp ? parseFloat(status.stemp) : 0;
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, currentTemperature);
        this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, targetTemperature);
        switch (status.mode) {
            case 'auto':
            case 'modified_auto':
                this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, this.platform.Characteristic.TargetHeatingCoolingState.AUTO);
                break;
            case 'manual':
                this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, this.platform.Characteristic.TargetHeatingCoolingState.HEAT);
                break;
            case 'off':
                this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, this.platform.Characteristic.TargetHeatingCoolingState.OFF);
                break;
        }
        const currentHeatingCoolingState = status.active
            ? this.platform.Characteristic.CurrentHeatingCoolingState.HEAT
            : this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, currentHeatingCoolingState);
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
    }
    async setTargetTemperature(value) {
        try {
            const stemp = Number(value).toFixed(1);
            await this.helkiClient.setStatus(this.accessory.context.device.dev_id, this.node, {
                stemp: stemp,
                mode: 'manual',
                units: 'C',
            });
            await this.refreshStatus();
        }
        catch (error) {
            this.platform.log.error('Failed to set target temperature:', error);
        }
    }
    async setTargetHeatingCoolingState(value) {
        let mode;
        if (value === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
            mode = 'manual';
        }
        else if (value === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
            mode = 'auto';
        }
        else {
            mode = 'off';
        }
        try {
            await this.helkiClient.setStatus(this.accessory.context.device.dev_id, this.node, { mode });
            await this.refreshStatus();
        }
        catch (error) {
            this.platform.log.error('Failed to set target heating/cooling state:', error);
        }
    }
}
exports.Radiator = Radiator;
//# sourceMappingURL=radiator.js.map