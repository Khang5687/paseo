---
title: 语音
description: Paseo 的语音架构、本地优先的模型执行以及 Provider 配置。
nav: 语音
---

# 语音 {#voice}

Paseo 对语音提供一流的支持，可用于口述输入，以及与编程环境进行语音模式对话。

## 设计理念 {#philosophy}

语音以本地优先。你可以完全在设备上运行语音功能，也可以为语音功能选择 OpenAI。对于语音推理和编排，Paseo 复用你机器上已安装并完成认证的 Agent Provider。

这让凭据和执行都留在你的环境中，也避免了引入一套独立的、只能在云端运行的语音系统。

## 架构 {#architecture}

- 语音输入输出：每个功能各自的 STT 和 TTS Provider（`local` 或 `openai`）
- 本地语音运行时：默认在 CPU 上执行的 ONNX 模型
- 语音模式对话：聊天自己的 Agent，以语音提示词重新加载。它通过调用 `speak` 工具出声回答。
- 工具路径：`speak` 属于 [Paseo 工具](/docs/mcp)。有原生工具接口的 Provider（OMP）直接获得它；其他 Provider 通过 Paseo MCP 服务器获得它。

语音模式需要打开 **启用 Paseo tools**（**Settings → Host → Tools & prompts**，或 `daemon.mcp.injectIntoAgents: true`）。工具注入默认关闭。关闭时，Agent 没有 `speak` 工具，所以 Paseo 会拒绝启动语音模式并说明原因。设置了 `paseoTools.enabled: false` 的 Provider 也会同样被拒绝。

## Agent 工作时说话 {#talking-while-the-agent-works}

Agent 运行期间也可以开启语音模式，并随时说话。

- 你一开口，正在播放的语音回复会立刻停止，Agent 继续工作。
- 你说完后，消息会加入 Agent 正在进行的轮次，与使用 **引导（Steer）** 发送方式输入的文字消息相同。如果 Agent 空闲，则开始新一轮。
- 要停止 Agent，请按 **停止**（红色方块）。语音开启且 Agent 运行时，它位于语音面板的末端。说话不会停止 Agent，结束语音也不会：挂断按钮和语音快捷键只关闭语音。
- 语音模式通过重新加载会话，为 Agent 配置语音提示和 `speak` 工具，而重新加载会结束正在运行的轮次。如果你在 Agent 运行期间开启语音模式，Paseo 会等这一轮结束后再应用它们。在此之前，你的消息会在没有 `speak` 工具的情况下送达 Agent，所以它用普通聊天消息回答，而不是朗读。运行期间关闭语音模式，同样会等这一轮结束。

## 发送消息 {#sending-a-message}

在 **设置 → 主机 → 语音 → 发送** 中选择语音消息的发送方式：

- **自动**（默认）：你停下说话约一秒后，消息就会发送。
- **说 “over”**：Paseo 会跨过停顿持续收听，直到你以 “over” 结尾。这个词本身不会发送。它只在作为最后一个词时生效，所以 “go over the plan” 或 “overall” 都不会触发发送。

消息准备好时会响一声短促的提示音。提示音之后约两秒内，说 “cancel”（或 “cancel that”）即可丢弃这条消息，Paseo 会回答 “Cancelled.”。如果你接着说别的内容，这条消息会立刻发送。只有整句都是这个词时才算取消：“cancel the build” 会作为消息发送。没有待发送的消息时，说 “cancel” 会听到 “Nothing to cancel.”。

无论你说什么语言，“over” 和 “cancel” 都是英文单词。关闭语音模式时，已经响过提示音的消息会发送，还在等待 “over” 的内容会被丢弃。主机升级到支持该功能的版本后，才会显示 **发送** 这一行。

## 在对话之间切换 {#moving-between-chats}

把命令单独说成一整句，语音就会切换到另一个对话，不用点屏幕：

- **“Go to fitup”**：打开该项目的对话，并在那里继续语音。项目里有多个对话时，Paseo 会按从新到旧读出最多五个对话名，然后问 “Which one?”。用名字（“food scan”）或序号（“the second one”）回答。说的内容对不上任何对话时，会听到 “No chat called that.”，这句话也不会发给任何 Agent。
- **“Go to fitup food scan”**：一次说出项目和对话。在当前项目里，只说对话名也可以（“go to food scan”）。
- **“List chats”** 或 **“Which chats”**：读出当前项目的对话，然后同样等你选择。
- **“Go back”**：回到语音之前所在的对话。

语音在新对话中开启后，Paseo 会说出你在哪里（“fitup, food scan.”）。这些命令没有提示音，也不需要说 “over”。名字是模糊匹配的：“fit up” 能找到 FitUp，长标题只说其中一段也可以。以 “go to” 开头但没有说出项目或对话的句子（“go to the auth module and add logging”）会照常发给 Agent。对话指未归档的顶层 Agent，子 Agent 不会列出。只会查找当前对话所在主机上的项目。这些命令是英文单词，并且需要支持该功能的 App 和主机。

## 向 Paseo 提问 {#asking-paseo}

以 “Paseo,” 开头并稍作停顿，Paseo 会直接朗读回答，而不是把这句话发给 Agent：

- “Paseo, which chats are waiting on me?”
- “Paseo, what's going on in fitup?”
- “Paseo, what did the agent just say?”

回答来自一个单独的小模型。它读取这台主机上的对话：名字和状态、等你处理的事项（审批、问题框、未回答的问题），以及当前对话和你点名的对话里的最近消息。它只能读，不会向任何对话发送内容。回答只有几句短话。稍慢时 Paseo 会先说 “One sec.”；20 秒内没有回答时会说 “Sorry, no answer.”。

停顿很重要：“Paseo app crashes on start” 没有停顿，会照常发给 Agent；句子中间出现 “Paseo” 也一样。只说 “Paseo.” 时，Paseo 会回答 “Yes?”，你的下一句就是问题。名字后面跟切换命令时仍然会切换（“Paseo, go to fitup”）。

在 **设置 > 语音 > 回答 “Paseo, …”** 中选择模型，或把 `features.voiceMode.sideHelperModel` 设为 `<provider>/<model>`。默认是 `omp/anthropic/claude-haiku-5-5`。每个问题会调用一次模型，附带最多约 6,000 个 token 的对话数据，会计入该提供方的用量。主机升级到支持该功能的版本后，才会显示这一行。

## 本地语音 {#local-speech}

本地语音默认使用模型 ID `parakeet-tdt-0.6b-v2-int8`（STT）和 `kokoro-en-v0_19`（TTS，speaker 0 / voice 00）。

本地 TTS 的 `numThreads`（1 到 32）设置朗读时使用的 CPU 线程数。未设置时，Paseo 使用 CPU 核心数的一半，最少 2、最多 6。线程越多，开口越快：在 12 核主机上，用 6 个线程代替 2 个，首个声音的等待时间从约 3.4 秒降到约 2 秒。

缺失的模型会在 daemon 启动时下载到 `$PASEO_HOME/models/local-speech`。只会下载缺失的文件。

### 本地 STT 模型与语言支持 {#local-stt-models-and-language-support}

| 模型 ID                     | 语言                                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parakeet-tdt-0.6b-v2-int8` | 仅英语（默认）。包含标点和大小写。                                                                                                                                                                                                                                    |
| `parakeet-tdt-0.6b-v3-int8` | 25 种欧洲语言，自动检测：保加利亚语、克罗地亚语、捷克语、丹麦语、荷兰语、英语、爱沙尼亚语、芬兰语、法语、德语、希腊语、匈牙利语、意大利语、拉脱维亚语、立陶宛语、马耳他语、波兰语、葡萄牙语、罗马尼亚语、俄语、斯洛伐克语、斯洛文尼亚语、西班牙语、瑞典语、乌克兰语。 |

**要使用英语以外的语言，请把本地 STT 模型切换为 `parakeet-tdt-0.6b-v3-int8`。** v3 会自动检测说话的语言，没有针对单个语言的设置。下面的 `language` 字段**不会**影响本地 Parakeet 模型（v2 仅支持英语，v3 自动检测）；它只适用于 OpenAI STT Provider。

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8", "language": "en" }
    },
    "voiceMode": {
      "llm": { "provider": "claude", "model": "haiku" },
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8", "language": "en" },
      "tts": { "provider": "local", "model": "kokoro-en-v0_19", "speakerId": 0 }
    }
  },
  "providers": {
    "local": {
      "modelsDir": "~/.paseo/models/local-speech"
    }
  }
}
```

对于多语言的本地口述，请把模型设置为 v3。它会自动检测语言，因此不需要 `language` 字段：

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v3-int8" }
    }
  }
}
```

`language` 字段只适用于 OpenAI STT Provider：口述使用 `features.dictation.stt.language`，语音模式使用 `features.voiceMode.stt.language`。如果省略语音语言，Paseo 会先使用口述语言，再退回到 `en`。它对本地 Parakeet 模型没有任何作用。

## OpenAI 语音选项 {#openai-voice-option}

把 Provider 字段设置为 `openai` 并提供 OpenAI 凭据，即可把口述、语音 STT 和语音 TTS 切换到 OpenAI。

```json
{
  "version": 1,
  "features": {
    "dictation": { "stt": { "provider": "openai" } },
    "voiceMode": {
      "stt": { "provider": "openai" },
      "tts": { "provider": "openai" }
    }
  },
  "providers": {
    "openai": {
      "stt": {
        "apiKey": "...",
        "baseUrl": "https://api.openai.com/v1"
      },
      "tts": {
        "apiKey": "...",
        "baseUrl": "https://api.openai.com/v1"
      }
    }
  }
}
```

`providers.openai.stt` 用于口述和语音模式的语音转文字，`providers.openai.tts` 用于语音模式的文字转语音。由于两者独立解析，你可以把 STT 和 TTS 指向不同的端点。未设置时，各自先退回到 `providers.openai.apiKey`/`baseUrl`，再退回到 `OPENAI_API_KEY`/`OPENAI_BASE_URL`。这些设置只配置 Paseo 的 OpenAI 语音流量，不会改变 Codex 或其他基于 OpenAI 的工具。

Paseo 在配置的 OpenAI base URL 下使用以下路径：

- 口述 STT：`/v1/audio/transcriptions`
- 语音模式 STT：`/v1/audio/transcriptions`
- 语音模式 TTS：`/v1/audio/speech`

## 语音朗读的内容 {#what-voice-reads-aloud}

Paseo 会在文字送入语音引擎之前先清理它。围栏代码块会被替换成“Code block”这几个词（每条消息只说一次），文件路径缩短为最后一段，URL 缩短为主机名。行内代码保留其中的词。聊天记录保留原文。语音提示词还会要求 Agent 先给出答案，最多三句短句，并把代码和路径留在屏幕上。

当 Agent 向你提问时，Paseo 会在问题出现的瞬间朗读，不必等 Agent 调用 `speak`：

- **问题卡片**：逐字朗读，然后读出各选项的标签。含多个问题的卡片会一次读一个。卡片等待期间，你接下来说的话会作为它的答案，而不是作为聊天消息发给 Agent；说话也不会打断正在等待这个答案的 Agent 运行。说出选项名（“Redis”“第二个”），或在卡片接受自由文本时直接口述答案。说“repeat”重听问题，说“dismiss”拒绝该问题。只有选项的卡片如果你的回答没有指向任何选项，Paseo 不会猜测，而是重新读一遍选项。
- **权限提示**：会朗读并提示“Answer it on screen”。语音永远不会批准或拒绝它们，因为听错的一声“yes”不应该执行命令。如果你在提示等待时开口，Paseo 会提醒你在屏幕上回答；你的话不会发给 Agent，提示也会保持打开。

每个聊天同一时间只能在一台设备上使用语音模式。第二台设备尝试启动时会看到“此聊天的语音已在另一台设备上开启”。

## 环境变量 {#environment-variables}

- `PASEO_VOICE_LLM_PROVIDER`：覆盖语音 Agent 的 Provider
- `PASEO_DICTATION_STT_PROVIDER`、`PASEO_VOICE_STT_PROVIDER`、`PASEO_VOICE_TTS_PROVIDER`：选择语音 Provider（`local` 或 `openai`）
- `OPENAI_STT_API_KEY`、`OPENAI_STT_BASE_URL`：OpenAI 语音转文字端点（口述 + 语音模式 STT）
- `OPENAI_TTS_API_KEY`、`OPENAI_TTS_BASE_URL`：OpenAI 文字转语音端点（语音模式 TTS）
- `PASEO_LOCAL_MODELS_DIR`：本地模型存储目录
- `PASEO_DICTATION_LOCAL_STT_MODEL`：本地口述 STT 模型 ID
- `PASEO_VOICE_LOCAL_STT_MODEL`、`PASEO_VOICE_LOCAL_TTS_MODEL`：本地语音 STT/TTS 模型 ID
- `PASEO_DICTATION_LANGUAGE`：口述 STT 语言（仅限 OpenAI STT；本地 Parakeet 会忽略）
- `PASEO_VOICE_LANGUAGE`：语音模式 STT 语言；未设置时退回到 `PASEO_DICTATION_LANGUAGE`（仅限 OpenAI STT；本地 Parakeet 会忽略）
- `PASEO_VOICE_LOCAL_TTS_SPEAKER_ID`、`PASEO_VOICE_LOCAL_TTS_SPEED`、`PASEO_VOICE_LOCAL_TTS_THREADS`：可选的本地语音 TTS 调优

## 使用须知 {#operational-notes}

语音模式可以启动和控制 Agent。请像对待直接的 Agent 指令一样谨慎对待语音提示词，尤其是在指定工作目录或执行破坏性操作时。

开启语音模式或听写时，手机上的音乐和其他音频会继续播放，只是音量变小；结束后恢复原来的音量。在 Android 上，播客类 App 可能会改为暂停，因为 Android 允许播放语音内容的 App 自行决定；语音模式开启期间，在音乐 App 里按播放会结束语音模式。

在 Android 上，语音面板里的麦克风按钮用来选择语音模式和听写使用哪个麦克风：手机自带麦克风、已连接的耳机，或“自动”。Paseo 会在这台手机上记住你的选择。如果记住的耳机没有连接，Android 会自动选择，直到它重新连接。iOS、桌面版和网页版没有麦克风按钮，使用系统的输入设备。
