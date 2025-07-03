const settings = {
    "minecraft_version": "1.21.1", // supports up to 1.21.1
    // "host": "host.docker.internal", // for docker
    "host": "127.0.0.1",  // for local
    "port": 55916,
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    
    "base_profile": "creative", // survival, creative, or god_mode
    "profiles": [
        "./sandbox_groq.json",
        "./groq_qwen.json",

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "load_memory": false, // load memory from previous session
    "init_message": "Respond with hello world and your name", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly
    "speak": false, // allows all bots to speak through system text-to-speech. works on windows, mac, on linux you need to `apt install espeak`
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": true, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": true, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": 3, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": -1, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 15, // max number of messages to keep in context
    "num_examples": 5, // number of examples to give to the model
    "max_commands": 20, // max number of commands that can be used in consecutive responses. -1 for no limit
    "verbose_commands": false, // show full command synt
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots
    "log_all_prompts": false, // log ALL prompts to file
}

export default settings;
