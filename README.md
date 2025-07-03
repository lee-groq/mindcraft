# Mindcraft 🧠⛏️

Crafting minds for Minecraft with LLMs and [Mineflayer!](https://prismarinejs.github.io/mineflayer/#/)

[FAQ](https://github.com/kolbytn/mindcraft/blob/main/FAQ.md) | [Discord Support](https://discord.gg/mp73p35dzC) | [Video Tutorial](https://www.youtube.com/watch?v=gRotoL8P8D8) | [Blog Post](https://kolbynottingham.com/mindcraft/) | [Contributor TODO](https://github.com/users/kolbytn/projects/1) | [Paper Website](https://mindcraft-minecollab.github.io/index.html) | [MineCollab](https://github.com/kolbytn/mindcraft/blob/main/minecollab.md) 


> [!Caution]
Do not connect this bot to public servers with coding enabled. This project allows an LLM to write/execute code on your computer. The code is sandboxed, but still vulnerable to injection attacks. Code writing is disabled by default, you can enable it by setting `allow_insecure_coding` to `true` in `settings.js`. Ye be warned.

## Requirements

- [Minecraft Java Edition](https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc) (up to v1.21.1, recommend v1.21.1)
- [Node.js Installed](https://nodejs.org/) (at least v18)
- One of these: [Groq API Key](https://console.groq.com/keys) | [Ollama Installed](https://ollama.com/download) |

## Install and Run

1. Make sure you have the requirements above.

2. Clone or download this repository (big green button) 'git clone https://github.com/kolbytn/mindcraft.git'

3. Rename `keys.example.json` to `keys.json` and fill in your API keys (you only need one). The desired model is set in `andy.json` or other profiles. For other models refer to the table below.

4. In terminal/command prompt, run `npm install` from the installed directory

5. Download ollama and pull their embedding model by running the command `ollama pull nomic-embed-text`

6. Start a minecraft world and open it to LAN on localhost port `55916`

7. Run `node main.js sandbox` (to run in sandbox mode using settings.js) or `node main.js npc` (to run in npc mode using npc_settings.js) from the installed directory

If you encounter issues, check the [FAQ](https://github.com/kolbytn/mindcraft/blob/main/FAQ.md) or find support on [discord](https://discord.gg/mp73p35dzC). We are currently not very responsive to github issues. To run tasks please refer to [Minecollab Instructions](minecollab.md#installation)

## Tasks

Bot performance can be roughly evaluated with Tasks. Tasks automatically intialize bots with a goal to aquire specific items or construct predefined buildings, and remove the bot once the goal is achieved.

To run tasks, you need python, pip, and optionally conda. You can then install dependencies with `pip install -r requirements.txt`. 

Tasks are defined in json files in the `tasks` folder, and can be run with: `python tasks/run_task_file.py --task_path=tasks/example_tasks.json`

For full evaluations, you will need to [download and install the task suite. Full instructions.](minecollab.md#installation)

## Model Customization

You can configure project details in `settings.js`. [See file.](settings.js)

You can configure the agent's name, model, and prompts in their profile like `andy.json` with the `model` field. For comprehensive details, see [Model Specifications](#model-specifications).

| API | Config Variable | Example Model name | Docs |
|------|------|------|------|
| `ollama` (local) | n/a | `ollama/llama3.1` | [docs](https://ollama.com/library) |
| `groq` | `GROQCLOUD_API_KEY` | `groq/mixtral-8x7b-32768` | [docs](https://console.groq.com/docs/models) |

If you use Ollama, to install the models used by default (generation and embedding), execute the following terminal command:
`ollama pull llama3.1 && ollama pull nomic-embed-text`

### Online Servers
To connect to online servers your bot will need an official Microsoft/Minecraft account. You can use your own personal one, but will need another account if you want to connect too and play with it. To connect, change these lines in `settings.js`:
```javascript
"host": "111.222.333.444",
"port": 55920,
"auth": "microsoft",

// rest is same...
```
> [!Important]
> The bot's name in the profile.json must exactly match the Minecraft profile name! Otherwise the bot will spam talk to itself.

To use different accounts, Mindcraft will connect with the account that the Minecraft launcher is currently using. You can switch accounts in the launcer, then run `node main.js`, then switch to your main account after the bot has connected.

### Docker Container

If you intend to `allow_insecure_coding`, it is a good idea to run the app in a docker container to reduce risks of running unknown code. This is strongly recommended before connecting to remote servers.

```bash
docker run -i -t --rm -v $(pwd):/app -w /app -p 3000-3003:3000-3003 node:latest node main.js
```
or simply
```bash
docker-compose up
```

When running in docker, if you want the bot to join your local minecraft server, you have to use a special host address `host.docker.internal` to call your localhost from inside your docker container. Put this into your [settings.js](settings.js):

```javascript
"host": "host.docker.internal", // instead of "localhost", to join your local minecraft from inside the docker container
```

To connect to an unsupported minecraft version, you can try to use [viaproxy](services/viaproxy/README.md)

# Bot Profiles

Bot profiles are json files (such as `andy.json`) that define:

1. Bot backend LLMs to use for talking, coding, and embedding.
2. Prompts used to influence the bot's behavior.
3. Examples help the bot perform tasks.

## Model Specifications

LLM models can be specified simply as `"model": "gpt-4o"`. However, you can use different models for chat, coding, and embeddings. 
You can pass a string or an object for these fields. A model object must specify an `api`, and optionally a `model`, `url`, and additional `params`.

```json
"model": {
  "api": "openai",
  "model": "gpt-4o",
  "url": "https://api.openai.com/v1/",
  "params": {
    "max_tokens": 1000,
    "temperature": 1
  }
},
"code_model": {
  "api": "openai",
  "model": "gpt-4",
  "url": "https://api.openai.com/v1/"
},
"vision_model": {
  "api": "openai",
  "model": "gpt-4o",
  "url": "https://api.openai.com/v1/"
},
"embedding": {
  "api": "openai",
  "url": "https://api.openai.com/v1/",
  "model": "text-embedding-ada-002"
}

```

`model` is used for chat, `code_model` is used for newAction coding, `vision_model` is used for image interpretation, and `embedding` is used to embed text for example selection. If `code_model` or `vision_model` is not specified, `model` will be used by default. Not all APIs support embeddings or vision.

All apis have default models and urls, so those fields are optional. The `params` field is optional and can be used to specify additional parameters for the model. It accepts any key-value pairs supported by the api. Is not supported for embedding models.

## Embedding Models

Embedding models are used to embed and efficiently select relevant examples for conversation and coding.

Supported Embedding APIs: `openai`, `google`, `replicate`, `huggingface`, `novita`

If you try to use an unsupported model, then it will default to a simple word-overlap method. Expect reduced performance, recommend mixing APIs to ensure embedding support.

## Specifying Profiles via Command Line

By default, the program will use the profiles specified in `settings.js`. You can specify one or more agent profiles using the `--profiles` argument: `node main.js --profiles ./profiles/andy.json ./profiles/jill.json`

## Patches

Some of the node modules that we depend on have bugs in them. To add a patch, change your local node module file and run `npx patch-package [package-name]`

## Citation:

```
@article{mindcraft2025,
  title = {Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning},
  author = {White*, Isadora and Nottingham*, Kolby and Maniar, Ayush and Robinson, Max and Lillemark, Hansen and Maheshwari, Mehul and Qin, Lianhui and Ammanabrolu, Prithviraj},
  journal = {arXiv preprint arXiv:2504.17950},
  year = {2025},
  url = {https://arxiv.org/abs/2504.17950},
}
```
