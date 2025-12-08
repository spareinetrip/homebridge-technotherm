# Homebridge Technotherm

![Node v18.x](https://github.com/duggan/homebridge-technotherm/actions/workflows/build_node18.yml/badge.svg)
![Node v20.x](https://github.com/duggan/homebridge-technotherm/actions/workflows/build_node20.yml/badge.svg)
![Node v22.x](https://github.com/duggan/homebridge-technotherm/actions/workflows/build_node22.yml/badge.svg)

Technotherm / Lucht LHZ radiators in Apple Home via Homebridge.

**Status:** Functional ⚙️

Potentially can be modified to support a variety of other radiators (e.g. Haverland) that use the same cloud service for configuration (api.helki.com).

## Requirements

* **Username**: username registered with Lucht LHZ app
* **Password**: password registered with the Lucht LHZ app
* **Node.js**: 18.20.4+, 20.15.1+, or 22+

## Installation

### For Custom/Local Installation (Raspberry Pi)

Since backups only restore official npm-published plugins, custom plugins must be installed manually:

1. **Transfer plugin to Raspberry Pi:**
   ```bash
   # From your Mac
   scp -r /Users/julien/homebridge-technotherm pi@<raspberry-pi-ip>:/home/pi/homebridge-technotherm
   
   # Or clone from Git
   git clone <your-repo-url> homebridge-technotherm
   ```

2. **Build and install:**
   ```bash
   cd ~/homebridge-technotherm
   npm install
   npm run build
   sudo npm install -g .
   ```

3. **Configure Homebridge** (see Configuration below)

4. **Restart Homebridge:**
   ```bash
   sudo systemctl restart homebridge
   ```

### Alternative Installation Methods

**From Git repository:**
```bash
git clone <repo-url> homebridge-technotherm
cd homebridge-technotherm
npm install && npm run build
sudo npm install -g .
```

**Using npm link (development):**
```bash
cd ~/homebridge-technotherm
npm install && npm run build
sudo npm link
```

## Configuration

Add to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "Technotherm",
      "name": "Technotherm",
      "username": "your-lucht-lhz-username",
      "password": "your-lucht-lhz-password",
      "apiName": "api-lhz",
      "clientId": "54bccbfb41a9a5113f0488d0",
      "clientSecret": "vdivdi",
      "home": "Your Home Name",
      "httpServerPort": 8080,
      "shellyIp": "192.168.1.22"
    }
  ]
}
```

**Required fields:**
- `username`: Your Lucht LHZ app username
- `password`: Your Lucht LHZ app password
- `apiName`: Usually "api-lhz" (default)
- `clientId`: Usually "54bccbfb41a9a5113f0488d0" (default)
- `clientSecret`: Usually "vdivdi" (default)

**Optional fields:**
- `home`: Only needed if you have multiple homes in your account
- `httpServerPort`: Port for HTTP server (default: 8080, set to 0 to disable)
- `shellyIp`: IP address of Shelly Wall Display for bidirectional sync (optional)

## Shelly Wall Display Integration

The plugin includes a HomeKit switch ("Radiator Mode") and HTTP endpoints for Shelly integration:

- **ON** = All radiators in AUTO mode
- **OFF** = All radiators in MANUAL mode at 17°C

### How It Works

1. **HTTP Server** exposes two endpoints:
   - `/set-all-auto` - Sets all radiators to AUTO mode
   - `/set-all-manual` - Sets all radiators to MANUAL mode at 17°C

2. **HomeKit Switch** ("Radiator Mode") appears in Apple Home automatically

3. **Bidirectional Synchronization**:
   - Shelly switch → Updates radiators AND Apple Home switch
   - Apple Home switch → Updates radiators AND Shelly switch (remote control)
   - Both switches stay perfectly synchronized

### Prerequisites

1. **Find your Homebridge IP address** (check router, run `ifconfig`, or check Homebridge logs)
2. **Configure `httpServerPort`** in config.json (default: 8080, set to 0 to disable)
3. **Configure `shellyIp`** in config.json for full bidirectional sync (required for Apple Home to control Shelly)

### Step 1: Verify HTTP Server

After restarting Homebridge, check logs. You should see:
```
HTTP server started on port 8080
Available endpoints:
  GET http://<homebridge-ip>:8080/set-all-auto
  GET http://<homebridge-ip>:8080/set-all-manual
Creating new radiator mode switch
```

**Test endpoints** (from any device on your network):
- `http://<homebridge-ip>:8080/set-all-auto`
- `http://<homebridge-ip>:8080/set-all-manual`

You should see a JSON response like:
```json
{
  "success": true,
  "message": "Set 5 radiators to AUTO mode",
  "successful": 5,
  "failed": 0
}
```

**Check Apple Home**: Open Home app, you should see a new switch called "Radiator Mode".

### Step 2: Configure Shelly Wall Display

#### 2.1: Configure Input Settings

1. **Access Shelly web interface**: `http://<shelly-ip>` (e.g., `http://192.168.1.22`)

2. **Navigate to Input (0) Settings**:
   - Settings → Input (0) → Settings tab

3. **Set Input Mode**:
   - Select **"Switch"** (radio button)
   - Click **"Save settings"**

4. **Detach Input from Output** (CRITICAL):
   - Find **"Attached to output"** section
   - Select **"Detached"** (radio button) ⚠️
   - This prevents the switch from directly controlling the relay
   - Click **"Save settings"**

**Note**: If you're using a digital switch on the Wall Display screen (like "Chauffages (0)"), you may need to configure that switch instead of Input (0). Check your Shelly interface to see which switch appears on the screen.

#### 2.2: Create Actions

Navigate to **Actions → Input (0)** (or your switch name) → **Create new Action**

**Action 1: Switch ON → AUTO Mode**
- **Action Name**: `Radiators AUTO` (or any name)
- **Enable action**: ✓ Checked
- **61. Active time**: Leave as `--:--` (or set specific times)
- **62. Execute when**: Select **"Input toggled on"** (or "Switch toggled on")
- **63. Then do**: Click **"+ Add url"**
- **URL**: `http://<homebridge-ip>:8080/set-all-auto`
  - Example: `http://192.168.1.118:8080/set-all-auto`
- Click **"Save Action"**

**Action 2: Switch OFF → MANUAL Mode**
- Click **"Create new Action"** again
- **Action Name**: `Radiators MANUAL` (or any name)
- **Enable action**: ✓ Checked
- **61. Active time**: Leave as `--:--` (or set specific times)
- **62. Execute when**: Select **"Input toggled off"** (or "Switch toggled off")
- **63. Then do**: Click **"+ Add url"**
- **URL**: `http://<homebridge-ip>:8080/set-all-manual`
  - Example: `http://192.168.1.118:8080/set-all-manual`
- Click **"Save Action"**

**You only need 2 actions total!** Both should be on the same switch (Input (0) or your digital switch).

### Step 3: Test Both Switches

**Test Shelly Switch:**
1. Toggle switch ON → All radiators go to AUTO, Apple Home switch turns ON
2. Toggle switch OFF → All radiators go to MANUAL, Apple Home switch turns OFF

**Test Apple Home Switch:**
1. Toggle "Radiator Mode" ON → All radiators go to AUTO, Shelly switch turns ON (if `shellyIp` configured)
2. Toggle "Radiator Mode" OFF → All radiators go to MANUAL, Shelly switch turns OFF (if `shellyIp` configured)

**Both switches should always show the same state!**

### How Synchronization Works

**When Shelly switch is toggled:**
1. Shelly triggers action → Calls `/set-all-auto` or `/set-all-manual`
2. All radiators update via Helki API
3. Apple Home switch automatically syncs to match

**When Apple Home switch is toggled:**
1. All radiators update via Helki API
2. If `shellyIp` is configured, Shelly switch is remotely controlled via RPC API:
   - `GET http://<shelly-ip>/rpc/Switch.Set?id=0&on=true` (or `on=false`)
3. Shelly switch state updates on Wall Display

**Background synchronization:**
- Every 30 seconds: Plugin checks radiator states and updates both switches
- Every 10 seconds (if `shellyIp` configured): Plugin queries Shelly state and syncs Apple Home switch

**Key Point**: With `shellyIp` configured, you get **full bidirectional control** - either switch can control the other, and they always stay in sync!

## Updating

```bash
cd ~/homebridge-technotherm
git pull          # If using git
npm install
npm run build
sudo npm install -g .
sudo systemctl restart homebridge
```

## Troubleshooting

### Plugin Installation

**Plugin not found:**
```bash
npm list -g homebridge-technotherm
# If not found: sudo npm install -g ~/homebridge-technotherm
```

**Build errors:**
```bash
cd ~/homebridge-technotherm
rm -rf node_modules && npm install && npm run build
```

**Permission errors:**
```bash
sudo npm install -g .
```

**Check Node.js version:**
```bash
node -v  # Should be 18.20.4+, 20.15.1+, or 22+
```

**Verify installation:**
```bash
sudo journalctl -u homebridge -f
# Look for plugin loading and HTTP server starting
```

### Shelly Integration

**HTTP Server Not Starting:**
- Check that port 8080 is not already in use
- Verify `httpServerPort` setting in config.json
- Check Homebridge logs for error messages

**Shelly Can't Reach Homebridge:**
- Ensure both devices are on the same network
- Verify Homebridge IP address is correct in Shelly action URLs
- Check firewall settings on Homebridge machine
- Test endpoint in browser: `http://<homebridge-ip>:8080/set-all-auto`

**Shelly Switch Not Syncing with Apple Home:**
- Verify `shellyIp` is correctly set in config.json
- Check Shelly IP address is correct and reachable
- Test Shelly RPC API: `http://<shelly-ip>/rpc/Switch.GetStatus?id=0`
- Verify switch is set to "Detached" in Input settings
- Check Homebridge logs for Shelly communication errors

**Switch Actions Not Working:**
- Verify URLs in Shelly actions are correct (check for typos)
- Ensure both actions are enabled (checkbox checked)
- Verify trigger conditions: "Input toggled on" and "Input toggled off"
- Test endpoints manually in browser first
- Verify Input (0) is set to "Detached" mode

**Apple Home Switch Not Controlling Shelly:**
- Verify `shellyIp` is set in config.json
- Check Shelly IP address is correct
- Test Shelly RPC API: `http://<shelly-ip>/rpc/Switch.GetStatus?id=0`
- Restart Homebridge after adding/changing `shellyIp`

**Radiators Not Responding:**
- Check Homebridge logs for errors
- Verify Helki API credentials are correct
- Test endpoints directly in browser first

## Installing Other Custom Plugins

The same process works for any custom Homebridge plugin:

1. Transfer/clone to Raspberry Pi
2. `cd` into plugin directory
3. `npm install && npm run build` (if TypeScript)
4. `sudo npm install -g .`
5. Add to `config.json`
6. Restart Homebridge

## Audience

Works for me, might work for you! You'll need to be comfortable digging into Homebridge code if you want to tinker/add functionality or figure out why something doesn't work, but there's nothing esoteric in there, just wiring up APIs.

## Credits

This would have been a lot more difficult without Graham Bennett's [smartbox](https://github.com/graham33/smartbox) project, and the various contributors in the [Home Assistant forum discussion around it](https://community.home-assistant.io/t/haverland-radiators-smart-box-integration/133596). Thanks to everyone there!
