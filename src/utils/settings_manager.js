// settings_manager.js - Centralized settings management
import sandboxSettings from '../../settings.js';
import npcSettings from '../../npc_settings.js';

let currentMode = 'sandbox';
let currentSettings = sandboxSettings;

export function getSettings() {
    return currentSettings;
}

export function setMode(mode) {
    if (mode === 'npc') {
        currentMode = 'npc';
        currentSettings = npcSettings;
    } else {
        currentMode = 'sandbox';
        currentSettings = sandboxSettings;
    }
    return currentSettings;
}

export function getCurrentMode() {
    return currentMode;
}

export default getSettings(); 