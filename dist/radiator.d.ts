import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { Technotherm } from './platform';
import { HelkiClient, Status } from './helki_client';
export declare class Radiator {
    private readonly platform;
    private readonly accessory;
    private readonly helkiClient;
    private service;
    private node;
    constructor(platform: Technotherm, accessory: PlatformAccessory, helkiClient: HelkiClient);
    onDeviceUpdate(status: Status): void;
    registerCharacteristics(): void;
    setTargetTemperature(value: CharacteristicValue): Promise<void>;
    setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void>;
}
//# sourceMappingURL=radiator.d.ts.map