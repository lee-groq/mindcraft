import * as Mindcraft from './src/mindcraft/mindcraft.js';
import { setMode, getCurrentMode } from './src/utils/settings_manager.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync } from 'fs';

function parseArguments() {
    return yargs(hideBin(process.argv))
        .command('sandbox', 'Run in sandbox mode (default)', {}, (argv) => {
            argv.mode = 'sandbox';
        })
        .command('npc', 'Run in NPC mode', {}, (argv) => {
            argv.mode = 'npc';
        })
        .option('profiles', {
            type: 'array',
            describe: 'List of agent profile paths',
        })
        .option('task_path', {
            type: 'string',
            describe: 'Path to task file to execute'
        })
        .option('task_id', {
            type: 'string',
            describe: 'Task ID to execute'
        })
        .help()
        .alias('help', 'h')
        .parse();
}
const args = parseArguments();

// Set the mode based on command line arguments
let currentSettings = setMode(args.mode || 'sandbox');
console.log(`Running in ${getCurrentMode()} mode with ${getCurrentMode() === 'npc' ? '_default_npc.json' : '_default.json'} as default profile`);

if (args.profiles) {
    currentSettings.profiles = args.profiles;
}
if (args.task_path) {
    let tasks = JSON.parse(readFileSync(args.task_path, 'utf8'));
    if (args.task_id) {
        currentSettings.task = tasks[args.task_id];
        currentSettings.task.task_id = args.task_id;
    }
    else {
        throw new Error('task_id is required when task_path is provided');
    }
}

// these environment variables override certain settings
if (process.env.MINECRAFT_PORT) {
    currentSettings.port = process.env.MINECRAFT_PORT;
}
if (process.env.MINDSERVER_PORT) {
    currentSettings.mindserver_port = process.env.MINDSERVER_PORT;
}
if (process.env.PROFILES && JSON.parse(process.env.PROFILES).length > 0) {
    currentSettings.profiles = JSON.parse(process.env.PROFILES);
}
if (process.env.INSECURE_CODING) {
    currentSettings.allow_insecure_coding = true;
}
if (process.env.BLOCKED_ACTIONS) {
    currentSettings.blocked_actions = JSON.parse(process.env.BLOCKED_ACTIONS);
}
if (process.env.MAX_MESSAGES) {
    currentSettings.max_messages = process.env.MAX_MESSAGES;
}
if (process.env.NUM_EXAMPLES) {
    currentSettings.num_examples = process.env.NUM_EXAMPLES;
}
if (process.env.LOG_ALL) {
    currentSettings.log_all_prompts = process.env.LOG_ALL;
}

Mindcraft.init(false, currentSettings.mindserver_port);

for (let profile of currentSettings.profiles) {
    const profile_json = JSON.parse(readFileSync(profile, 'utf8'));
    currentSettings.profile = profile_json;
    currentSettings.mode = getCurrentMode(); // Pass the mode explicitly
    Mindcraft.createAgent(currentSettings);
}