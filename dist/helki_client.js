"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HelkiClient = void 0;
const axios_1 = __importDefault(require("axios"));
const axios_retry_1 = __importDefault(require("axios-retry"));
const socket_io_client_1 = __importDefault(require("socket.io-client"));
const MIN_TOKEN_LIFETIME = 60; // seconds
class HelkiClient {
    constructor(apiName, clientId, clientSecret, username, password, log) {
        this.socketNamespace = '/api/v2/socket_io';
        this.apiHost = `https://${apiName}.helki.com`;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.username = username;
        this.password = password;
        this.log = log;
        this.accessToken = '';
        this.expiresAt = new Date();
        this.axiosInstance = axios_1.default.create({
            baseURL: this.apiHost,
            timeout: 10000,
        });
        // Add a request interceptor
        this.axiosInstance.interceptors.request.use(config => {
            return config; // Always return the config object
        }, error => {
            if (error.response) {
                // Log any request error
                this.log.error('Request error:', error);
            }
            return Promise.reject(error);
        });
        // Add a response interceptor
        this.axiosInstance.interceptors.response.use(response => {
            // Log the response details
            return response; // Always return the response object
        }, error => {
            if (error.response) {
                // Log error details including the response from the server
                this.log.error(`Error response from ${error.response.config.url}:`, error.response);
            }
            return Promise.reject(error);
        });
        (0, axios_retry_1.default)(this.axiosInstance, {
            retries: 5,
            retryDelay: axios_retry_1.default.exponentialDelay,
            retryCondition: (error) => axios_retry_1.default.isNetworkOrIdempotentRequestError(error) || error.response?.status === 429,
        });
    }
    async subscribeToDeviceUpdates(deviceId, node, callback) {
        await this.checkRefresh();
        const socket = (0, socket_io_client_1.default)(this.apiHost + this.socketNamespace, {
            query: {
                token: this.accessToken,
                dev_id: deviceId,
            },
        });
        socket.on('update', (data) => {
            const path = data && data.head ? data.head.path : undefined;
            // alleen updates voor de juiste node doorlaten
            if (!path || !path.endsWith(`/${node.type}/${node.addr}/status`)) {
                return;
            }
            this.log.debug(`Device ${deviceId} node ${node.addr} updated:`, data);
            callback(data.body);
        });
        socket.on('connect_timeout', () => {
            this.log.warn('Socket connection timed out');
        });
        socket.on('reconnecting', async (attempt) => {
            this.log.info('Reconnecting to socket. Attempt: ', attempt);
            await this.checkRefresh();
            // token vernieuwen in de query
            if (!socket.io.opts.query) {
                socket.io.opts.query = {};
            }
            socket.io.opts.query.token = this.accessToken;
        });
        socket.on('reconnect_error', (error) => {
            this.log.error('Socket reconnection error:', error);
        });
        socket.on('error', (error) => {
            this.log.error('Socket error:', error);
        });
        socket.on('connect_error', (error) => {
            this.log.error('Socket connection error:', error);
        });
        socket.on('disconnect', async (reason) => {
            this.log.debug('Socket disconnected, attempting reconnect: ', reason);
            await this.checkRefresh();
            if (!socket.io.opts.query) {
                socket.io.opts.query = {};
            }
            socket.io.opts.query.token = this.accessToken;
            socket.connect();
        });
        socket.on('connect', () => {
            this.log.debug('Connected to socket');
        });
    }
    async auth() {
        this.log.info(`Authenticating via ${this.apiHost}`);
        const tokenUrl = `${this.apiHost}/client/token`;
        const tokenData = new URLSearchParams({
            grant_type: 'password',
            username: this.username,
            password: this.password,
        }).toString();
        const basicAuthCredentials = { username: this.clientId, password: this.clientSecret };
        const response = await this.axiosInstance.post(tokenUrl, tokenData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            auth: basicAuthCredentials,
        });
        const { access_token, refresh_token, expires_in } = response.data;
        if (!access_token || !refresh_token || !expires_in) {
            throw new Error('Invalid auth response');
        }
        this.accessToken = access_token;
        this.expiresAt = new Date(Date.now() + expires_in * 1000);
        if (expires_in < MIN_TOKEN_LIFETIME) {
            this.log.warn(`Token expires in ${expires_in}s, which is below the minimum lifetime of ${MIN_TOKEN_LIFETIME}s.`);
        }
        this.log.info(`Successfully authenticated via ${this.apiHost}`);
    }
    hasTokenExpired() {
        return (this.expiresAt.getTime() - Date.now()) < MIN_TOKEN_LIFETIME * 1000;
    }
    async checkRefresh() {
        if (this.hasTokenExpired()) {
            await this.auth();
        }
    }
    getHeaders() {
        return {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
        };
    }
    // eslint-disable-next-line
    async apiRequest(path, method = 'GET', data) {
        await this.checkRefresh();
        const url = `${this.apiHost}/api/v2/${path}`;
        const headers = this.getHeaders();
        const apiData = data ? ` ${JSON.stringify(data)}` : '';
        try {
            const response = await (method === 'GET'
                ? this.axiosInstance.get(url, { headers })
                : this.axiosInstance.post(url, data, { headers }));
            this.log.debug(`API ${method} request for ${url}${apiData} => ${JSON.stringify(response.data)}`);
            return response.data;
        }
        catch (error) {
            if (error instanceof Error) {
                throw new Error(`API request to ${path} failed: ${error.message}`);
            }
            throw new Error(`API request to ${path} failed: ${error}`);
        }
    }
    async getDevices() {
        return this.apiRequest('devs');
    }
    async getGroupedDevices() {
        return this.apiRequest('grouped_devs');
    }
    async getNodes(deviceId) {
        const response = await this.apiRequest(`devs/${deviceId}/mgr/nodes`);
        return response.nodes;
    }
    async getStatus(deviceId, node) {
        return this.apiRequest(`devs/${deviceId}/${node.type}/${node.addr}/status`, 'GET');
    }
    async setStatus(deviceId, node, status) {
        // Here, you might want to validate the statusArgs to ensure it only contains writable properties
        await this.apiRequest(`devs/${deviceId}/${node.type}/${node.addr}/status`, 'POST', status);
    }
    async getSetup(deviceId, node) {
        return this.apiRequest(`devs/${deviceId}/${node.type}/${node.addr}/setup`);
    }
    async setSetup(deviceId, node, setupArgs) {
        let setupData = await this.getSetup(deviceId, node); // Assuming this returns the current setup in a directly usable format
        setupData = { ...setupData, ...setupArgs }; // Merge with new setup arguments
        return this.apiRequest(`devs/${deviceId}/${node.type}/${node.addr}/setup`, 'POST', setupData);
    }
    async getDeviceAwayStatus(deviceId) {
        return this.apiRequest(`devs/${deviceId}/mgr/away_status`);
    }
    async setDeviceAwayStatus(deviceId, statusArgs) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const data = Object.fromEntries(Object.entries(statusArgs).filter(([_, v]) => v !== null));
        return this.apiRequest(`devs/${deviceId}/mgr/away_status`, 'POST', data);
    }
    async getDevicePowerLimit(deviceId) {
        const resp = await this.apiRequest(`devs/${deviceId}/htr_system/power_limit`);
        return parseInt(resp.power_limit, 10);
    }
    async setDevicePowerLimit(deviceId, powerLimit) {
        const data = { power_limit: powerLimit.toString() };
        await this.apiRequest(`devs/${deviceId}/htr_system/power_limit`, 'POST', data);
    }
}
exports.HelkiClient = HelkiClient;
//# sourceMappingURL=helki_client.js.map