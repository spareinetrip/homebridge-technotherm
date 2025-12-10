import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { HelkiClient } from './helki_client';
import * as http from 'http';
import * as url from 'url';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Radiator } from './radiator';
import { RadiatorModeSwitch } from './radiator_mode_switch';

/**
 * Technotherm
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class Technotherm implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  private radiatorInstances: Map<string, Radiator> = new Map(); // Track Radiator instances by UUID

  /**
   * Get a Radiator instance by accessory UUID
   */
  public getRadiatorInstance(uuid: string): Radiator | undefined {
    return this.radiatorInstances.get(uuid);
  }
  private helkiClient: HelkiClient | null = null;
  private httpServer: http.Server | null = null;
  private radiatorModeSwitch: RadiatorModeSwitch | null = null;
  private radiatorModeSwitchAccessory: PlatformAccessory | null = null;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
      // Start HTTP server if configured
      this.startHttpServer();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // Check if this is the radiator mode switch
    if (accessory.UUID === this.api.hap.uuid.generate('RADIATOR-MODE-SWITCH')) {
      this.radiatorModeSwitchAccessory = accessory;
      // Will be initialized after helkiClient is ready
    } else {
      // add the restored accessory to the accessories cache so we can track if it has already been registered
      this.accessories.push(accessory);
    }
  }

  /**
   * Authenticate with the API to obtain an access token and fetch the list of devices.
   */
  async discoverDevices() {
    let backoffDelay = 1000; // Initial delay of 1 second
    const maxBackoffDelay = 60 * 60 * 1000; // Maximum delay of 1 hour (in milliseconds)

    // eslint-disable-next-line no-constant-condition
    while (true) { // Continue indefinitely
      try {
        const helki = new HelkiClient(
          this.config.apiName,
          this.config.clientId,
          this.config.clientSecret,
          this.config.username,
          this.config.password,
          this.log,
        );

        // Store helki client for HTTP endpoints
        this.helkiClient = helki;

        const groups = await helki.getGroupedDevices();
        // Filter on home if specified
        const home = groups.find(home => home.name === this.config.home);

        for (const group of groups) {
          // Loop over the devices in the group
          for (const device of group.devs) {
            const nodes = await helki.getNodes(device.dev_id);

            if (nodes.length === 0) {
              this.log.warn(`No nodes found for device: ${device.name}`);
              continue;
            }

            for (const node of nodes) {
              const accessoryName = node.name || device.name;
              const accessoryUUID = this.api.hap.uuid.generate(node.uid || device.dev_id);
              const existingAccessory = this.accessories.find(accessory => accessory.UUID === accessoryUUID);

              if (existingAccessory) {
                if (home && existingAccessory?.context.home !== home.name) {
                  this.log.warn(`Removing accessory that does not match configured home "${home.name}: ${existingAccessory.displayName}"`);
                  try {
                    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
                  } catch (error: unknown) {
                    this.log.warn(`existing accessory: ${error}`);
                  }
                } else {
                  if (existingAccessory.displayName !== accessoryName) {
                    this.log.info(`Renaming accessory from ${existingAccessory.displayName} to ${accessoryName}`);
                    existingAccessory.displayName = accessoryName;
                    this.api.updatePlatformAccessories([existingAccessory]);
                  }

                  this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
                  const radiator = new Radiator(this, existingAccessory, helki);
                  this.radiatorInstances.set(existingAccessory.UUID, radiator);
                }
              } else {
                const accessory = new this.api.platformAccessory(accessoryName, accessoryUUID);
                accessory.context.device = device;
                accessory.context.node = node;
                accessory.context.home = group.name;
                if (home !== undefined && home.name === group.name) {
                  this.log.info('Adding new accessory:', accessoryName);
                  const radiator = new Radiator(this, accessory, helki);
                  this.radiatorInstances.set(accessory.UUID, radiator);
                  this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                }
                if (home === undefined) {
                  this.log.info('Adding new accessory:', accessoryName);
                  const radiator = new Radiator(this, accessory, helki);
                  this.radiatorInstances.set(accessory.UUID, radiator);
                  this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                }
              }
            }
          }
        }

        // If successful, reset delay
        backoffDelay = 1000;
        
        // Create or restore the radiator mode switch accessory
        // If it was restored from cache, initialize it now
        if (this.radiatorModeSwitchAccessory && !this.radiatorModeSwitch) {
          this.log.info('Initializing restored radiator mode switch');
          this.radiatorModeSwitch = new RadiatorModeSwitch(this, this.radiatorModeSwitchAccessory, helki);
        } else if (!this.radiatorModeSwitchAccessory) {
          // Create new switch
          this.createRadiatorModeSwitch(helki);
        }
        
        break;

      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('getaddrinfo')) {
          this.log.error(`Network error encountered: ${error.message}. Retrying in ${backoffDelay / 1000} seconds...`);

          // Wait for the backoff delay before retrying
          await new Promise(resolve => setTimeout(resolve, backoffDelay));

          // Exponential backoff with a maximum delay of 1 hour
          backoffDelay = Math.min(backoffDelay * 2, maxBackoffDelay);
        } else {
          this.log.error(`Failed to discover devices: ${error instanceof Error ? error.message : error}`);
          break;
        }
      }
    }
  }

  /**
   * Start HTTP server to allow external devices (like Shelly) to control all radiators
   */
  private startHttpServer() {
    const port = this.config.httpServerPort || 8080;
    
    if (port === 0) {
      this.log.debug('HTTP server disabled (port set to 0)');
      return;
    }

    this.httpServer = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url || '', true);
      const path = parsedUrl.pathname || '';
      const method = req.method || 'GET';

      // Enable CORS for local network access
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Handle different endpoints
      if (path === '/set-all-auto' && method === 'GET') {
        this.setAllRadiatorsToAuto(res);
      } else if (path === '/set-all-manual' && method === 'GET') {
        this.setAllRadiatorsToManual(res);
      } else if (path === '/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', radiators: this.accessories.length }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.httpServer.listen(port, () => {
      this.log.info(`HTTP server started on port ${port}`);
      this.log.info(`Available endpoints:`);
      this.log.info(`  GET http://<homebridge-ip>:${port}/set-all-auto - Set all radiators to AUTO mode`);
      this.log.info(`  GET http://<homebridge-ip>:${port}/set-all-manual - Set all radiators to MANUAL mode at 19°C`);
      this.log.info(`  GET http://<homebridge-ip>:${port}/health - Health check`);
    });

    this.httpServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        this.log.error(`Port ${port} is already in use. HTTP server not started.`);
      } else {
        this.log.error(`HTTP server error: ${error.message}`);
      }
    });
  }

  /**
   * Create the radiator mode switch accessory
   */
  private createRadiatorModeSwitch(helki: HelkiClient) {
    const switchUUID = this.api.hap.uuid.generate('RADIATOR-MODE-SWITCH');
    const existingSwitch = this.accessories.find(acc => acc.UUID === switchUUID);

    if (existingSwitch) {
      this.log.info('Restoring radiator mode switch from cache');
      this.radiatorModeSwitchAccessory = existingSwitch;
      this.radiatorModeSwitch = new RadiatorModeSwitch(this, existingSwitch, helki);
    } else {
      this.log.info('Creating new radiator mode switch');
      const switchAccessory = new this.api.platformAccessory('Radiator Mode', switchUUID);
      this.radiatorModeSwitchAccessory = switchAccessory;
      this.radiatorModeSwitch = new RadiatorModeSwitch(this, switchAccessory, helki);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [switchAccessory]);
      this.accessories.push(switchAccessory);
    }
  }

  /**
   * Set all radiators to AUTO mode
   */
  private async setAllRadiatorsToAuto(res: http.ServerResponse) {
    if (!this.helkiClient) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Helki client not initialized' }));
      return;
    }

    try {
      const results = await Promise.allSettled(
        this.accessories.map(async (accessory) => {
          const device = accessory.context.device;
          const node = accessory.context.node;
          await this.helkiClient!.setStatus(device.dev_id, node, { mode: 'auto' });
          
          // Clear forced flag when switching to AUTO mode
          const radiator = this.radiatorInstances.get(accessory.UUID);
          if (radiator) {
            radiator.clearForcedTo19C();
          }
          
          return { name: accessory.displayName, status: 'success' };
        })
      );

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      this.log.info(`Set ${successful} radiators to AUTO mode${failed > 0 ? `, ${failed} failed` : ''}`);

      // Sync HomeKit switch state
      if (this.radiatorModeSwitch) {
        await this.radiatorModeSwitch.updateState(true);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `Set ${successful} radiators to AUTO mode`,
        successful,
        failed,
      }));
    } catch (error) {
      this.log.error('Failed to set all radiators to AUTO:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }

  /**
   * Set all radiators to MANUAL mode at 19°C
   */
  private async setAllRadiatorsToManual(res: http.ServerResponse) {
    if (!this.helkiClient) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Helki client not initialized' }));
      return;
    }

    try {
      const results = await Promise.allSettled(
        this.accessories.map(async (accessory) => {
          const device = accessory.context.device;
          const node = accessory.context.node;
          await this.helkiClient!.setStatus(device.dev_id, node, {
            mode: 'manual',
            stemp: '19.0',
            units: 'C',
          });
          
          // Mark radiator as forced to 19°C to prevent Socket.IO/polling from overwriting
          const radiator = this.radiatorInstances.get(accessory.UUID);
          if (radiator) {
            radiator.markForcedTo19C();
          }
          
          return { name: accessory.displayName, status: 'success' };
        })
      );

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      this.log.info(`Set ${successful} radiators to MANUAL mode at 19°C${failed > 0 ? `, ${failed} failed` : ''}`);

      // Sync HomeKit switch state
      if (this.radiatorModeSwitch) {
        await this.radiatorModeSwitch.updateState(false);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `Set ${successful} radiators to MANUAL mode at 19°C`,
        successful,
        failed,
      }));
    } catch (error) {
      this.log.error('Failed to set all radiators to MANUAL:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }

}
