import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { GroqCloudAPI } from '../models/groq.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands, getCommandDocs } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { say } from './speak.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        
        // Initialize components with more detailed error handling
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile, settings.mode);
        this.name = this.prompter.getName();
        console.log(`Initializing agent ${this.name}...`);
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });

        const spawnTimeout = setTimeout(() => {
            process.exit(0);
        }, 30000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }
            
            // Break on single character responses (likely model errors)
            if (res.trim().length === 1) {
                console.warn('single character response, likely model error:', res);
                break;
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    console.warn('Agent hallucinated command:', command_name);
                    
                    // Check if hallucination detection is enabled
                    if (settings.command_hallucination_detection) {
                        // Analyze if a real command should have been used
                        const analysisResult = await this.analyzeCommandHallucination(res, command_name);
                        
                        if (analysisResult.startsWith('SUGGEST:')) {
                            const suggestedCommand = analysisResult.replace('SUGGEST:', '').trim();
                            const suggested_command_name = containsCommand(suggestedCommand);
                            
                            if (suggested_command_name && commandExists(suggested_command_name)) {
                                console.log(`Command correction: ${command_name} → ${suggested_command_name}`);
                                
                                // Replace the hallucinated command with the suggested one
                                const correctedResponse = res.replace(command_name, suggestedCommand);
                                
                                // Update history with corrected response
                                this.history.add(this.name, correctedResponse);
                                
                                // Re-extract the command name from corrected response
                                command_name = suggested_command_name;
                                res = correctedResponse;
                            } else {
                                // Suggested command doesn't exist either, treat as regular hallucination
                                this.history.add('system', `Command ${command_name} does not exist.`);
                                continue;
                            }
                        } else {
                            // No command needed, treat as regular hallucination
                            this.history.add('system', `Command ${command_name} does not exist.`);
                            continue;
                        }
                    } else {
                        // Hallucination detection disabled, use original behavior
                        this.history.add('system', `Command ${command_name} does not exist.`);
                        continue;
                    }
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.verbose_commands) {
                    this.routeResponse(source, res);
                }
                else { // only output command name
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res) {
                    this.history.add('system', execute_res);
                    
                    // For search commands, also communicate results to user
                    if (command_name === '!search') {
                        this.routeResponse(source, execute_res.replace('SEARCH RESULTS:\n', ''));
                        break;
                    }
                } else {
                    break;
                }
            }
            else { // conversation response
                // Check if intent detection is enabled and analyze for missing commands
                if (settings.command_hallucination_detection && settings.command_intent_detection) {
                    const intentResult = await this.analyzeCommandIntent(res, {source});
                    
                    if (intentResult.startsWith('SUGGEST:')) {
                        const suggestedCommand = intentResult.replace('SUGGEST:', '').trim();
                        const suggested_command_name = containsCommand(suggestedCommand);
                        
                        if (suggested_command_name && commandExists(suggested_command_name)) {
                            console.log(`Intent detected: Adding command ${suggested_command_name} to response`);
                            
                            // Handle commands that need player names
                            let finalCommand = suggestedCommand;
                            if (suggested_command_name === '!followPlayer' || suggested_command_name === '!goToPlayer') {
                                // If the command needs a player name but uses a placeholder, replace with actual source
                                if (source && source !== 'system' && source !== this.name) {
                                    finalCommand = finalCommand.replace(/("player"|"[^"]*")/, `"${source}"`);
                                }
                            }
                            
                            // Append the suggested command to the response
                            const enhancedResponse = `${res} ${finalCommand}`;
                            
                            // Add enhanced response to history
                            this.history.add(this.name, enhancedResponse);
                            
                            // Route the conversational part first
                            this.routeResponse(source, res);
                            
                            // Then execute the suggested command
                            let execute_res = await executeCommand(this, enhancedResponse);
                            console.log('Agent executed intent-detected command:', suggested_command_name, 'and got:', execute_res);
                            used_command = true;
                            
                            if (execute_res) {
                                this.history.add('system', execute_res);
                                
                                // For search commands, also communicate results to user
                                if (suggested_command_name === '!search') {
                                    this.routeResponse(source, execute_res.replace('SEARCH RESULTS:\n', ''));
                                }
                            }
                            break;
                        }
                    }
                }
                
                // Default conversation response handling
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
	    if (settings.speak) {
            say(to_translate);
	    }
            this.bot.chat(message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        this.bot.on('end', (reason) => {
            console.warn('Bot disconnected! Killing agent process.', reason)
            this.cleanKill('Bot disconnected! Killing agent process.');
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            console.warn('Bot kicked!', reason);
            this.cleanKill('Bot kicked! Killing agent process.');
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.x.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            this.actions.resumeAction();
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        process.exit(code);
    }

    async analyzeCommandHallucination(original_response, hallucinated_command) {
        try {
            // Initialize small model for command analysis
            const analysisModel = new GroqCloudAPI('llama-3.1-8b-instant');
            
            // Create analysis prompt
            const analysisPrompt = `You are a Minecraft bot command analyzer. A bot gave this response: "${original_response}"

The bot tried to use a command "${hallucinated_command}" that doesn't exist.

Available commands include:
${getCommandDocs(this).substring(0, 2000)}...

TASK: Determine if the bot should have used a real command instead. If so, suggest the correct command with proper syntax.

Respond with ONLY one of these formats:
1. "NO_COMMAND" - if no command was needed
2. "SUGGEST: !commandName(params)" - if you found a suitable replacement command

Examples:
- If bot said "I'll go to coordinates" and used !goToCoords, suggest "SUGGEST: !goToCoordinates"
- If bot said "Let me collect some wood" and used !gatherWood, suggest "SUGGEST: !collectBlocks"
- If bot was just chatting normally, respond "NO_COMMAND"

Response:`;

            const result = await analysisModel.sendRequest([], analysisPrompt);
            return result.trim();
        } catch (error) {
            console.error('Error analyzing command hallucination:', error);
            return 'NO_COMMAND';
        }
    }

    async analyzeCommandIntent(response, context = {}) {
        try {
            // Initialize small model for intent analysis
            const analysisModel = new GroqCloudAPI('llama-3.1-8b-instant');
            
            // Get nearby players for context
            const nearbyPlayers = Object.keys(this.bot.players).filter(p => p !== this.name);
            const contextInfo = nearbyPlayers.length > 0 ? `\n\nNearby players: ${nearbyPlayers.join(', ')}` : '';
            
            // Create intent analysis prompt
            const intentPrompt = `You are a Minecraft bot intent analyzer. A bot gave this response: "${response}"

The bot's response contains NO commands, but it might be expressing intent to perform an action.
${contextInfo}

Available commands include:
${getCommandDocs(this).substring(0, 2000)}...

TASK: Determine if the bot's response implies they should execute a command. If so, suggest the appropriate command with reasonable default parameters.

Respond with ONLY one of these formats:
1. "NO_COMMAND" - if no command is implied
2. "SUGGEST: !commandName(params)" - if the response implies an action should be taken

Examples:
- "I'll follow you!" → "SUGGEST: !followPlayer(\"${nearbyPlayers[0] || 'player'}\", 3)"
- "Let me go to coordinates 100, 64, 200" → "SUGGEST: !goToCoordinates(100, 64, 200, 2)"  
- "I need to collect some wood" → "SUGGEST: !collectBlocks(\"oak_log\", 10)"
- "Going to get some food" → "SUGGEST: !searchForEntity(\"cow\", 64)"
- "I'll craft some tools" → "SUGGEST: !craftRecipe(\"wooden_pickaxe\", 1)"
- "Time to sleep" → "SUGGEST: !goToBed()"
- "Let me equip my sword" → "SUGGEST: !equip(\"wooden_sword\")"
- "Just saying hello!" → "NO_COMMAND"

IMPORTANT: 
- Only suggest commands when the bot clearly expresses intent to perform a specific action
- Don't suggest commands for casual conversation or acknowledgments
- Use reasonable default parameters (distances, quantities, etc.)
- For player-related commands, use the first nearby player if available

Response:`;

            const result = await analysisModel.sendRequest([], intentPrompt);
            return result.trim();
        } catch (error) {
            console.error('Error analyzing command intent:', error);
            return 'NO_COMMAND';
        }
    }

    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
