// extremely lightweight obj that can be imported/modified by any file
import settingsManager from '../utils/settings_manager.js';

let settings = {};
Object.assign(settings, settingsManager);

export default settings;
export function setSettings(new_settings) {
    Object.keys(settings).forEach(key => delete settings[key]);
    Object.assign(settings, new_settings);
}
