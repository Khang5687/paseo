export type VoiceSpeakHandler = (params: {
  text: string;
  callerAgentId: string;
  signal?: AbortSignal;
}) => Promise<void>;

export interface VoiceCallerContext {
  childAgentDefaultLabels?: Record<string, string>;
  lockedCwd?: string;
  allowCustomCwd?: boolean;
  enableVoiceTools?: boolean;
}

/** Another socket already holds voice mode for this agent. */
export class VoiceModeAlreadyActiveError extends Error {
  constructor() {
    super("Voice mode is already active for this agent");
    this.name = "VoiceModeAlreadyActiveError";
  }
}
