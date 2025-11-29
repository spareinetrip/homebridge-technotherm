import { Logger } from 'homebridge';
interface StatusArgs {
    [key: string]: string | number;
}
interface SetupArgs {
    [key: string]: string | number;
}
interface Device {
    dev_id: string;
    name: string;
    product_id: string;
    fw_version: string;
    serial_id: string;
}
interface Node {
    name?: string;
    type: string;
    addr: string;
    installed?: boolean;
    lost?: boolean;
    uid?: string;
}
interface GroupedDevices {
    id: string;
    name: string;
    devs: Device[];
    owner: boolean;
}
interface SetStatus {
    mode?: 'auto' | 'manual' | 'off';
    units?: 'C' | 'F';
    stemp?: string;
}
interface Status {
    mode: 'auto' | 'manual' | 'off' | 'modified_auto';
    units: 'C' | 'F';
    stemp: string;
    mtemp: string;
    ice_temp: string;
    eco_temp: string;
    comf_temp: string;
    active: boolean;
    locked: number;
    presence: boolean;
    window_open: boolean;
    true_radiant_active: boolean;
    boost: boolean;
    boost_end_min: number;
    boost_end_day: number;
    power: string;
    duty: number;
    act_duty: number;
    pcb_temp: string;
    power_pcb_temp: string;
    error_code: string;
    sync_status: string;
}
interface SetupResponse {
    sync_status: 'ok';
    control_mode: number;
    units: 'C' | 'F';
    power: string;
    offset: string;
    away_mode: number;
    away_offset: string;
    modified_auto_span: number;
    window_mode_enabled: boolean;
    true_radiant_enabled: boolean;
    user_duty_factor: number;
    flash_version: string;
    factory_options: {
        temp_compensation_enabled: boolean;
        window_mode_available: boolean;
        true_radiant_available: boolean;
        duty_limit: number;
        boost_config: number;
        button_double_press: boolean;
        prog_resolution: number;
        bbc_value: number;
        bbc_available: boolean;
        lst_value: number;
        lst_available: boolean;
        fil_pilote_available: boolean;
        backlight_time: number;
        button_down_code: number;
        button_up_code: number;
        button_mode_code: number;
        button_prog_code: number;
        button_off_code: number;
        button_boost_code: number;
        splash_screen_type: number;
    };
    extra_options: {
        boost_temp: string;
        boost_time: number;
        bright_on_level: number;
        bright_off_level: number;
        backlight_time: number;
        beep_active: boolean;
        language: number;
        style: number;
        time_format: number;
        date_format: number;
    };
}
declare class HelkiClient {
    private apiHost;
    private clientId;
    private clientSecret;
    private username;
    private password;
    private axiosInstance;
    private accessToken;
    private expiresAt;
    private log;
    private socketNamespace;
    constructor(apiName: string, clientId: string, clientSecret: string, username: string, password: string, log: Logger);
    subscribeToDeviceUpdates(deviceId: string, node: Node, callback: (status: Status) => void): Promise<void>;
    private auth;
    private hasTokenExpired;
    private checkRefresh;
    private getHeaders;
    private apiRequest;
    getDevices(): Promise<Device[]>;
    getGroupedDevices(): Promise<GroupedDevices[]>;
    getNodes(deviceId: string): Promise<Node[]>;
    getStatus(deviceId: string, node: Node): Promise<Status>;
    setStatus(deviceId: string, node: Node, status: SetStatus): Promise<void>;
    getSetup(deviceId: string, node: Node): Promise<SetupResponse>;
    setSetup(deviceId: string, node: Node, setupArgs: SetupArgs): Promise<unknown>;
    getDeviceAwayStatus(deviceId: string): Promise<unknown>;
    setDeviceAwayStatus(deviceId: string, statusArgs: StatusArgs): Promise<unknown>;
    getDevicePowerLimit(deviceId: string): Promise<number>;
    setDevicePowerLimit(deviceId: string, powerLimit: number): Promise<void>;
}
export { HelkiClient, Device, Node, Status, StatusArgs, SetStatus };
//# sourceMappingURL=helki_client.d.ts.map