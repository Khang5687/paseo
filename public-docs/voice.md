---
title: Voice
description: Paseo voice architecture, local-first model execution, and provider configuration.
nav: Voice
order: 41
category: Configuration
---

# Voice

Paseo has first-class voice support for dictation and voice mode conversations with your coding environment.

## Philosophy

Voice is local-first. You can run speech fully on-device, or choose OpenAI for speech features. For voice reasoning/orchestration, Paseo reuses agent providers already installed and authenticated on your machine.

This keeps credentials and execution in your environment and avoids introducing a separate cloud-only voice stack.

## Architecture

- Speech I/O: STT and TTS providers per feature (`local` or `openai`)
- Local speech runtime: ONNX models executed on CPU by default
- Voice mode conversation: the chat's own agent, reloaded with a voice prompt. It answers aloud by calling the `speak` tool.
- Tooling path: `speak` is part of the [Paseo tools](/docs/mcp). Providers with a native tool interface (OMP) receive it directly; the others receive it through the Paseo MCP server.

Voice mode needs **Enable Paseo tools** on (**Settings → Host → Tools & prompts**, or `daemon.mcp.injectIntoAgents: true`). Tool injection is off by default. With it off, the agent has no `speak` tool, so Paseo refuses to start voice mode and shows why. A provider with `paseoTools.enabled: false` is refused the same way.

## Talking While the Agent Works

You can start voice mode while the agent is running, and talk at any time.

- When you start speaking, spoken replies stop playing at once. The agent keeps working.
- When you finish speaking, your message joins the agent's running turn, the same as a typed message sent with the **Steer** send behavior. If the agent is idle, it starts a turn.
- To stop the agent, press **Stop**. Speaking never stops it.
- Voice mode gives the agent a voice prompt and a `speak` tool by reloading its session, and a reload ends a running turn. If you start voice mode during a run, Paseo waits for the run to finish and then applies them. Until then your messages reach the agent without the `speak` tool, so it answers in normal chat messages instead of speaking. Turning voice mode off during a run waits for the run to finish in the same way.

## Local Speech

Local speech defaults to model IDs `parakeet-tdt-0.6b-v2-int8` (STT) and `kokoro-en-v0_19` (TTS, speaker 0 / voice 00).

Dictation is on by default. Voice mode is off until you turn it on in **Settings > Voice** or set `features.voiceMode.enabled: true`.

Missing models for enabled features are downloaded at daemon startup into `$PASEO_HOME/models/local-speech`. Downloads happen only for missing files. **Settings > Voice** lists every local model with its size and languages, and lets you download or delete each one.

### Local STT models and language support

**Settings > Voice** lists every local STT model with the languages it supports. The default, `parakeet-tdt-0.6b-v2-int8`, is English-only. For other languages, pick a multilingual model such as `parakeet-tdt-0.6b-v3-int8` (25 European languages) or `whisper-base` (99 languages). The `language` field is passed to STT sessions for both providers. Local recognizers currently detect the spoken language themselves; setting `language` does not expand a model’s supported languages.

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8" }
    },
    "voiceMode": {
      "llm": { "provider": "claude", "model": "haiku" },
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8" },
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

For multilingual local dictation, set a multilingual model. No `language` field is needed:

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

For either STT provider, set `features.dictation.stt.language` for dictation and `features.voiceMode.stt.language` for voice mode. If voice language is omitted, Paseo uses the dictation language before falling back to `en`.

## OpenAI Voice Option

Set `provider` to `openai` and enter credentials at each use site that needs them.
Dictation, listening and speaking each own their key, base URL and model:

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "openai", "apiKey": "sk-...", "model": "gpt-4o-mini-transcribe" }
    },
    "voiceMode": {
      "enabled": true,
      "stt": {
        "provider": "openai",
        "apiKey": "sk-...",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-4o-transcribe",
        "language": "en"
      },
      "tts": { "provider": "openai", "apiKey": "sk-...", "model": "tts-1", "voice": "alloy" }
    }
  }
}
```

| Provider | Speech-to-text fields                                           | Text-to-speech fields                 |
| -------- | --------------------------------------------------------------- | ------------------------------------- |
| `local`  | `model`, `language`                                             | `model`, `speakerId`, `speed`         |
| `openai` | `apiKey`, `baseUrl`, `model`, `language`, `confidenceThreshold` | `apiKey`, `baseUrl`, `model`, `voice` |

Fields other than `provider` are optional. Omit `model` to use the provider's default.
OpenAI model and voice names accept custom IDs from compatible servers. Keys saved
on the host are write-only in the app.

A saved `apiKey` or `baseUrl` wins over env settings. Without a saved value, STT
uses `OPENAI_STT_API_KEY` / `OPENAI_STT_BASE_URL`, TTS uses
`OPENAI_TTS_API_KEY` / `OPENAI_TTS_BASE_URL`, and both fall back to
`OPENAI_API_KEY` / `OPENAI_BASE_URL`. These settings affect Paseo speech traffic.

Existing `providers.openai` settings load automatically into OpenAI use sites that
lack inline values. Endpoint settings take precedence over the old shared settings.
The next save writes the inline shape. A legacy key without an OpenAI site to
receive it is dropped with a warning; enter a key when you later select OpenAI.

Paseo uses these paths under the configured OpenAI base URL:

- dictation STT: `/v1/audio/transcriptions`
- voice mode STT: `/v1/audio/transcriptions`
- voice mode TTS: `/v1/audio/speech`

## What Voice Reads Aloud

Paseo cleans text before it reaches the speech engine. Fenced code blocks are replaced by the words "Code block" (once per message), file paths shrink to their last segment, and URLs shrink to their host. Inline code keeps its words. The chat log keeps the original text. The voice prompt also tells the agent to answer first, in at most three short sentences, and to leave code and paths on screen.

When the agent asks you something, Paseo reads it as soon as it appears, without waiting for the agent to call `speak`:

- **Question cards** are read word for word, followed by the option labels. A card with several questions is read one at a time. While a card waits, your next spoken reply answers it instead of going to the agent as chat, and speaking does not interrupt the agent run that is waiting on the answer. Name an option ("Redis", "the second one"), or give a typed answer when the card takes free text. Say "repeat" to hear the question again, or "dismiss" to decline it. A reply that names no option on an options-only card is not guessed: Paseo reads the options again.
- **Permission prompts** are read aloud with "Answer it on screen". Voice never approves or denies them, because a misheard "yes" must not run a command. If you speak while one waits, Paseo reminds you to answer on screen. Your words are not sent to the agent, and the prompt stays open.

Voice mode runs on one device per chat. A second device that tries to start it sees "Voice is on for this chat on another device".

## Environment Variables

Provider, enablement, model, language, voice and tuning env vars override config.
Keys and base URLs follow the fallback rule above.

- `PASEO_DICTATION_ENABLED`, `PASEO_VOICE_MODE_ENABLED`, feature enablement
- `STT_MODEL`, model override for both OpenAI STT sites
- `STT_CONFIDENCE_THRESHOLD`, confidence threshold for both OpenAI STT sites
- `TTS_MODEL`, `TTS_VOICE`, OpenAI speaking model and voice

- `PASEO_VOICE_LLM_PROVIDER`, voice agent provider override
- `PASEO_DICTATION_STT_PROVIDER`, `PASEO_VOICE_STT_PROVIDER`, `PASEO_VOICE_TTS_PROVIDER`, speech provider selection (`local` or `openai`)
- `OPENAI_STT_API_KEY`, `OPENAI_STT_BASE_URL`, OpenAI speech-to-text endpoint (dictation + voice mode STT)
- `OPENAI_TTS_API_KEY`, `OPENAI_TTS_BASE_URL`, OpenAI text-to-speech endpoint (voice mode TTS)
- `PASEO_LOCAL_MODELS_DIR`, local model storage directory
- `PASEO_DICTATION_LOCAL_STT_MODEL`, local dictation STT model ID
- `PASEO_VOICE_LOCAL_STT_MODEL`, `PASEO_VOICE_LOCAL_TTS_MODEL`, local voice STT/TTS model IDs
- `PASEO_DICTATION_LANGUAGE`, dictation STT language
- `PASEO_VOICE_LANGUAGE`, voice mode STT language; falls back to `PASEO_DICTATION_LANGUAGE` when unset
- `PASEO_VOICE_LOCAL_TTS_SPEAKER_ID`, `PASEO_VOICE_LOCAL_TTS_SPEED`, optional local voice TTS tuning

## Operational Notes

Voice mode can launch and control agents. Treat voice prompts with the same care as direct agent instructions, especially when specifying working directories or destructive operations.

Music and other audio on the phone keep playing, quieter, while voice mode or dictation is on, and return to full volume when it stops. On Android, a podcast app may pause instead, because Android lets apps that play speech choose, and pressing play in a music app while voice mode is on ends voice mode.
