import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { getCurrentMode } from '../utils/settings_manager.js';

import { GroqCloudAPI } from './groq.js';
import { VLLM } from './vllm.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Prompter {
    constructor(agent, profile, mode = null) {
        this.agent = agent;
        this.profile = profile;
        
        // Select the appropriate default profile based on the current mode
        const currentMode = mode || getCurrentMode();
        const defaultProfilePath = currentMode === 'npc' 
            ? './profiles/defaults/_default_npc.json'
            : './profiles/defaults/_default_sandbox.json';
            
        let default_profile = JSON.parse(readFileSync(defaultProfilePath, 'utf8'));
        let base_fp = '';
        if (settings.base_profile.includes('survival')) {
            base_fp = './profiles/defaults/survival.json';
        } else if (settings.base_profile.includes('creative')) {
            base_fp = './profiles/defaults/creative.json';
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = './profiles/defaults/god_mode.json';
        }
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;

        // try to get "max_tokens" parameter, else null
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = this._selectAPI(this.profile.model);
        this.chat_model = this._createModel(chat_model_profile);

        if (this.profile.code_model) {
            let code_model_profile = this._selectAPI(this.profile.code_model);
            this.code_model = this._createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = this._selectAPI(this.profile.vision_model);
            this.vision_model = this._createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        let embedding = this.profile.embedding;
        if (embedding === undefined) {
            if (chat_model_profile.api !== 'ollama')
                embedding = {api: chat_model_profile.api};
            else
                embedding = {api: 'none'};
        }
        else if (typeof embedding === 'string' || embedding instanceof String)
            embedding = {api: embedding};

        console.log('Using embedding settings:', embedding);

        try {
            if (embedding.api === 'ollama')
                this.embedding_model = new Local(embedding.model, embedding.url);
            else {
                this.embedding_model = null;
                let embedding_name = embedding ? embedding.api : '[NOT SPECIFIED]'
                console.warn('Unsupported embedding: ' + embedding_name + '. Using word-overlap instead, expect reduced performance. Recommend using a supported embedding model. See Readme.');
            }
        }
        catch (err) {
            console.warn('Warning: Failed to initialize embedding model:', err.message);
            console.log('Continuing anyway, using word-overlap instead.');
            this.embedding_model = null;
        }
        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        mkdirSync(`./bots/${name}`, { recursive: true });
        writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw new Error('Failed to save profile:', err);
            }
            console.log("Copy profile saved.");
        });
    }

    _selectAPI(profile) {
        if (typeof profile === 'string' || profile instanceof String) {
            profile = {model: profile};
        }
        if (!profile.api) {
            if (profile.model.includes('ollama/'))
                profile.api = 'ollama'; // also must do early because shares names with other models
            else if (profile.model.includes("groq/") || profile.model.includes("groqcloud/"))
                profile.api = 'groq';
            else 
                throw new Error('Unknown model:', profile.model);
        }
        return profile;
    }
    _createModel(profile) {
        let model = null;
        if (profile.api === 'ollama')
            model = new Local(profile.model.replace('ollama/', ''), profile.url, profile.params);
        else if (profile.api === 'groq')
            model = new GroqCloudAPI(profile.model.replace('groq/', '').replace('groqcloud/', ''), profile.url, profile.params);
        else
            throw new Error('Unknown API:', profile.api);
        return model;
    }
    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);
            
            // Wait for both examples to load before proceeding
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null) {
        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS'))
            prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs(this.agent));
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        if (prompt.includes('$MEMORY'))
            prompt = prompt.replaceAll('$MEMORY', this.agent.history.memory);
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            let self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, this.cooldown - elapsed));
        }
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages) {
        this.most_recent_msg_time = Date.now();
        let current_msg_time = this.most_recent_msg_time;

        for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
            await this.checkCooldown();
            if (current_msg_time !== this.most_recent_msg_time) {
                return '';
            }

            let prompt = this.profile.conversing;
            prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
            let generation;

            try {
                generation = await this.chat_model.sendRequest(messages, prompt);
                if (typeof generation !== 'string') {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                console.log("Generated response:", generation); 
                await this._saveLog(prompt, messages, generation, 'conversation');

            } catch (error) {
                console.error('Error during message generation or file writing:', error);
                continue;
            }

            // Check for hallucination or invalid output
            if (generation?.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');
                continue;
            }
            
            // Enhanced username hallucination detection - check anywhere in response, not just at start
            const usernames = [...new Set([
                ...messages.filter(m => m.role === 'user').map(m => m.content.split(':')[0]),
                ...settings.only_chat_with,
                this.agent.name
            ])];
            
            // Check for username patterns anywhere in the response (username: message)
            const usernamePatternAnywhere = new RegExp(`(^|\\n)\\s*(${usernames.join('|')})\\s*:\\s*`, 'i');
            if (usernamePatternAnywhere.test(generation)) {
                console.warn('LLM hallucinated user message anywhere in response. Trying again...');
                continue;
            }

            // Filter out system/action output patterns that should not appear in chat
            const systemOutputPatterns = [
                /^System output:/i,
                /^Action output:/i,
                /^Code output:/i,
                /^Code execution/i,
                /\bSystem output:\s*/gi,
                /\bAction output:\s*/gi,
                /\bCode output:\s*/gi
            ];
            
            let containsSystemOutput = false;
            for (const pattern of systemOutputPatterns) {
                if (pattern.test(generation)) {
                    console.warn('LLM generated system/action output in chat response. Trying again...');
                    containsSystemOutput = true;
                    break;
                }
            }
            if (containsSystemOutput) {
                continue;
            }

            // Filter out responses that announce silence instead of being silent
            const silenceAnnouncements = [
                /^(\s*|\t*)$/,  // Just whitespace or tabs
                /I will (stay|remain|be) (quiet|silent)/i,
                /I won't (say|speak|respond)/i,
                /(staying|remaining|being) (quiet|silent)/i,
                /no response/i,
                /nothing to (say|add)/i,
                /I'll (stay|remain|be) (quiet|silent)/i
            ];
            
            const trimmedGeneration = generation.trim();
            const isAnnouncingSilence = silenceAnnouncements.some(pattern => pattern.test(trimmedGeneration));
            if (isAnnouncingSilence && trimmedGeneration.length > 0) {
                console.warn('LLM announced silence instead of being silent. Returning empty response.');
                return '';
            }

            if (current_msg_time !== this.most_recent_msg_time) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                return '';
            } 

            if (generation?.includes('</think>')) {
                const [_, afterThink] = generation.split('</think>')
                generation = afterThink
            }

            // Remove trailing quotes and whitespace from the response
            generation = generation
                .trim()
                .replace(/'+\s*$/, '')
                .replace(/"+\s*$/, '')
                .replace(/['"]+\s*$/, '')
                .trim();

            // Final validation - ensure response is appropriate for chat
            if (this._isValidChatResponse(generation)) {
                return generation;
            } else {
                console.warn('Generated response failed final validation. Trying again...');
                continue;
            }
        }

        return '';
    }

    _isValidChatResponse(response) {
        if (!response || typeof response !== 'string') {
            return false;
        }
        
        const trimmed = response.trim();
        
        // Empty responses are valid (bot chooses to stay silent)
        if (trimmed.length === 0) {
            return true;
        }
        
        // Check for problematic patterns that indicate system confusion
        const problematicPatterns = [
            // /^`+[^`]*`+$/,  // Responses that are entirely wrapped in backticks
            /^Agent\s+/i,  // Responses that start with "Agent" (system perspective)
            /^Bot\s+/i,     // Responses that start with "Bot"
            /^AI\s+/i,      // Responses that start with "AI"
            /^The agent/i,  // Third person references to the agent
            /^The bot/i,    // Third person references to the bot
            /executing|execution/i,  // References to code execution
        ];
        
        return !problematicPatterns.some(pattern => pattern.test(trimmed));
    }

    async promptCoding(messages) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        await this.checkCooldown();
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

        let resp = await this.code_model.sendRequest(messages, prompt);
        this.awaiting_coding = false;
        await this._saveLog(prompt, messages, resp, 'coding');
        return resp;
    }

    async promptMemSaving(to_summarize) {
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize);
        
        let messages = [];
        
        let resp = await this.chat_model.sendRequest(messages, prompt);
        await this._saveLog(prompt, to_summarize, resp, 'memSaving');
        if (resp?.includes('</think>')) {
            const [_, afterThink] = resp.split('</think>')
            resp = afterThink
        }
        return resp;
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, null, null, messages);
        let res = await this.chat_model.sendRequest([], prompt);
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        return await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer);
    }

    async promptGoalSetting(messages, last_goals) {
        // deprecated
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO'
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!settings.log_all_prompts)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        let logDir;
        if (task_id == null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }


}
