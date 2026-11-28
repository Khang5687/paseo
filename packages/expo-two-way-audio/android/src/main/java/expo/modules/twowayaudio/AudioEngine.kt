import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.RequiresApi
import java.util.LinkedList
import java.util.Queue
import java.util.concurrent.Executors
import kotlin.math.pow

/**
 * A microphone the user can pick for voice and dictation. [key] stays the same when the device
 * reconnects, so it is what the remembered pick stores; [kind] is phone, bluetooth, wired, usb
 * or hearing_aid.
 */
data class MicrophoneRoute(val key: String, val kind: String, val name: String)

data class MicrophoneRoutes(
    val routes: List<MicrophoneRoute>,
    /** The remembered pick, or null for automatic. It may name a device that is not connected. */
    val preferredKey: String?,
    val preferredName: String?,
    /** The route in use while capturing or playing, else the one the next session would use. */
    val activeKey: String?,
)

class AudioEngine (context: Context) {
    companion object {
        /** Kept per phone, so the pick survives app restarts and is shared by voice and dictation. */
        const val PREFERENCES_NAME = "expo-two-way-audio"
        private const val PREFERRED_KEY = "preferredMicrophoneKey"
        private const val PREFERRED_NAME = "preferredMicrophoneName"
        const val PHONE_ROUTE_KEY = "phone"
    }

    private val SAMPLE_RATE = 16000
    private val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    private val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO

    private lateinit var audioRecord: AudioRecord
    private lateinit var audioManager: AudioManager
    private lateinit var audioTrack: AudioTrack
    private var audioFocusRequest: AudioFocusRequest? = null
    private val audioSampleQueue: Queue<ByteArray> = LinkedList()
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private val executorServiceMicrophone = Executors.newFixedThreadPool(1)
    private val executorServicePlayback = Executors.newFixedThreadPool(1)
    private enum class CaptureMode { CONVERSATION, DICTATION }
    private var captureMode = CaptureMode.CONVERSATION
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var captureSilenced = false
    private val recordingCallback = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
            if (!isRecording || !::audioRecord.isInitialized) return
            val config = configs.firstOrNull { it.clientAudioSessionId == audioRecord.audioSessionId }
                ?: return
            setCaptureSilenced(config.isClientSilenced)
        }
    }
    private val deviceCallback = object : android.media.AudioDeviceCallback() {
        override fun onAudioDevicesAdded(devices: Array<out AudioDeviceInfo>) {
            refreshMicrophoneRoutes()
        }
        override fun onAudioDevicesRemoved(devices: Array<out AudioDeviceInfo>) {
            refreshMicrophoneRoutes()
        }
    }
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private var activeRouteKey: String? = null
    private var communicationRouteActive = false
    private var bridgeWindowStartedAtMs = System.currentTimeMillis()
    private var micEvents = 0
    private var micBytes = 0L
    private var playbackEvents = 0
    private var playbackQueuedBytes = 0L
    private var playbackWrites = 0
    private var playbackWriteBytes = 0L

    @Volatile var isRecording = false
    private var isRecordingBeforePause = false
    var isPlaying = false

    // Callbacks
    var onMicDataCallback: ((ByteArray) -> Unit)? = null
    var onInputVolumeCallback: ((Float) -> Unit)? = null
    var onOutputVolumeCallback: ((Float) -> Unit)? = null
    var onAudioInterruptionCallback: ((String) -> Unit)? = null
    var onMicrophoneRoutesChangeCallback: (() -> Unit)? = null

    init {
        initializeAudio(context)
    }

    private fun flushBridgeStats(reason: String) {
        val now = System.currentTimeMillis()
        val elapsedMs = now - bridgeWindowStartedAtMs
        if (elapsedMs < 1000) {
            return
        }
        Log.d(
            "AudioEngine",
            "[bridge] $reason mic=$micEvents" +
                "ev/${micBytes}B playbackQueue=$playbackEvents" +
                "ev/${playbackQueuedBytes}B playbackWrites=$playbackWrites" +
                "ev/${playbackWriteBytes}B windowMs=$elapsedMs"
        )
        bridgeWindowStartedAtMs = now
        micEvents = 0
        micBytes = 0
        playbackEvents = 0
        playbackQueuedBytes = 0
        playbackWrites = 0
        playbackWriteBytes = 0
    }

    @SuppressLint("NewApi")
    private fun initializeAudio(context:Context) {
        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        // Initialization must not interrupt music before a capture/playback operation owns a session.
        audioManager.registerAudioDeviceCallback(deviceCallback, mainHandler)
        audioManager.registerAudioRecordingCallback(recordingCallback, mainHandler)

        val bufferSize = AudioTrack.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AUDIO_FORMAT
        )

        audioTrack = AudioTrack(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
            AudioFormat.Builder()
                .setEncoding(AUDIO_FORMAT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build(),
            bufferSize,
            AudioTrack.MODE_STREAM,
            audioManager.generateAudioSessionId()
        )
    }

    /**
     * Map an output device to the microphone route it stands for. Android picks the matching
     * input for a communication sink, so the speaker means the phone's own mic, and a headset
     * means its mic (headphones without one fall back to the phone's mic). The earpiece is left
     * out: voice replies there are too quiet to hear with the phone away from your ear.
     */
    private fun routeOf(device: AudioDeviceInfo): MicrophoneRoute? {
        val kind = when (device.type) {
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER ->
                return MicrophoneRoute(PHONE_ROUTE_KEY, "phone", device.productName.toString())
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
            // Before Android 12 a connected headset shows up as A2DP until SCO starts.
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return null else "bluetooth"
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
            AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
            AudioDeviceInfo.TYPE_HEARING_AID -> "hearing_aid"
            else -> return null
        }
        val name = device.productName.toString()
        return MicrophoneRoute("$kind:$name", kind, name)
    }

    /** One entry per route; a Bluetooth headset that shows as both SCO and A2DP is one route. */
    @SuppressLint("NewApi")
    private fun routeDevices(): List<Pair<AudioDeviceInfo, MicrophoneRoute>> {
        val devices = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.availableCommunicationDevices
        } else {
            audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
        }
        return devices.mapNotNull { device -> routeOf(device)?.let { device to it } }
            .distinctBy { it.second.key }
    }

    /** The remembered pick when it is connected, else Bluetooth, then wired, then the phone. */
    private fun chooseRoute(
        candidates: List<Pair<AudioDeviceInfo, MicrophoneRoute>>
    ): Pair<AudioDeviceInfo, MicrophoneRoute>? {
        val preferred = preferences.getString(PREFERRED_KEY, null)
        return candidates.firstOrNull { it.second.key == preferred }
            ?: candidates.firstOrNull { it.second.kind == "bluetooth" }
            ?: candidates.firstOrNull { it.second.kind == "wired" || it.second.kind == "usb" }
            ?: candidates.firstOrNull { it.second.kind == "phone" }
    }

    @SuppressLint("NewApi")
    private fun updateAudioRouting() {
        val chosen = chooseRoute(routeDevices())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val routed = try {
                chosen != null && audioManager.setCommunicationDevice(chosen.first)
            } catch (_: IllegalArgumentException) {
                // The device disconnected between enumeration and selection.
                false
            }
            if (!routed) audioManager.clearCommunicationDevice()
            activeRouteKey = if (routed) chosen?.second?.key else null
        } else {
            val kind = chosen?.second?.kind
            @Suppress("DEPRECATION")
            if (kind == "bluetooth") audioManager.startBluetoothSco() else audioManager.stopBluetoothSco()
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = kind == "phone"
            activeRouteKey = chosen?.second?.key
        }
        onMicrophoneRoutesChangeCallback?.invoke()
    }

    /** Reroute a live session, or only tell JS the list changed when none is live. */
    private fun refreshMicrophoneRoutes() {
        if (communicationRouteActive) updateAudioRouting() else onMicrophoneRoutesChangeCallback?.invoke()
    }

    fun getMicrophoneRoutes(): MicrophoneRoutes {
        val candidates = routeDevices()
        return MicrophoneRoutes(
            routes = candidates.map { it.second },
            preferredKey = preferences.getString(PREFERRED_KEY, null),
            preferredName = preferences.getString(PREFERRED_NAME, null),
            activeKey = if (communicationRouteActive) activeRouteKey else chooseRoute(candidates)?.second?.key,
        )
    }

    /**
     * Remember [key] as this phone's microphone (null = automatic) and switch to it now when a
     * session is live. Refuses a key that is not connected, since there would be no name to show
     * for it later.
     */
    fun setPreferredMicrophone(key: String?): Boolean {
        val route = key?.let { k -> routeDevices().firstOrNull { it.second.key == k }?.second }
        if (key != null && route == null) return false
        preferences.edit()
            .putString(PREFERRED_KEY, route?.key)
            .putString(PREFERRED_NAME, route?.name)
            .apply()
        // Route on the main thread, where the device callback also reroutes.
        mainHandler.post {
            refreshMicrophoneRoutes()
        }
        return true
    }

    @SuppressLint("NewApi")
    private fun activateCommunicationRoute() {
        communicationRouteActive = true
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        updateAudioRouting()
    }

    @SuppressLint("NewApi")
    private fun releaseCommunicationRoute() {
        communicationRouteActive = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = false
            @Suppress("DEPRECATION")
            audioManager.stopBluetoothSco()
        }
        audioManager.mode = AudioManager.MODE_NORMAL
    }

    /**
     * Give the complete communication session back once we are neither recording nor playing.
     * Focus ducks the user's music, while MODE_IN_COMMUNICATION and the selected communication
     * device can leave Bluetooth earbuds on their narrow-band call route after capture stops.
     */
    @SuppressLint("NewApi")
    fun releaseAudioSession() {
        if (isRecording || isPlaying) {
            return
        }
        audioFocusRequest?.let { request ->
            audioManager.abandonAudioFocusRequest(request)
            audioFocusRequest = null
        }
        if (::audioTrack.isInitialized) {
            audioTrack.pause()
        }
        releaseCommunicationRoute()
    }

    /**
     * Take the audio session back before playing, mirroring iOS `activateAudioSessionIfNeeded()`.
     *
     * `releaseAudioSession()` abandons focus and pauses the track once we go idle, so a playback
     * turn that starts after that release has to reclaim both. Without this, the assistant's
     * response plays with no focus held and competes with whatever the user is listening to.
     * A null [audioFocusRequest] is what "we released" looks like, so it is the guard against
     * re-requesting focus mid-turn.
     *
     * Focus is best effort here, and deliberately not fatal. `playPCMData` is fire-and-forget
     * from JS — `playAudio()` settles on a duration timer, not on a native ack — so refusing to
     * queue would report a chunk as played that nobody heard. Playing unfocused is what this
     * path did before the session was ever released, and it is the better failure. Leaving the
     * request outstanding instead of abandoning it is also what lets a delayed grant arrive
     * later through the listener, which is the point of `setAcceptsDelayedFocusGain(true)`.
     */
    @SuppressLint("NewApi")
    private fun acquireAudioSessionIfNeeded() {
        if (audioFocusRequest != null) {
            return
        }
        activateCommunicationRoute()
        requestAudioFocus()
        if (::audioTrack.isInitialized) {
            audioTrack.play()
        }
    }

    /**
     * Ask for transient focus that lets other audio keep playing quietly under us.
     *
     * `GAIN_TRANSIENT_EXCLUSIVE` paused the user's music for the whole voice session. With
     * `MAY_DUCK`, Android lowers other players itself (API 26+ auto-ducking) and restores them
     * when we abandon focus. Players that mark their content as speech (most podcast apps) are
     * not auto-ducked: Android tells their app instead, and that app decides whether to pause.
     */
    @SuppressLint("NewApi")
    private fun requestAudioFocus(): Boolean {
        audioFocusRequest?.let { request ->
            audioManager.abandonAudioFocusRequest(request)
            audioFocusRequest = null
        }

        lateinit var focusRequest: AudioFocusRequest
        focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAcceptsDelayedFocusGain(true)
                .setOnAudioFocusChangeListener { focusChange ->
                    if (audioFocusRequest !== focusRequest) return@setOnAudioFocusChangeListener
                    when (focusChange) {
                        AudioManager.AUDIOFOCUS_GAIN -> {
                            Log.d("AudioEngine", "Audio focus gained")
                        }
                        AudioManager.AUDIOFOCUS_LOSS -> {
                            Log.d("AudioEngine", "Audio focus lost")
                            handleAudioFocusBlocked()
                        }
                        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                            Log.d("AudioEngine", "Audio focus lost transiently")
                            handleAudioFocusBlocked()
                        }
                        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                            Log.d("AudioEngine", "Audio focus duck requested")
                        }
                    }
                }
                .build()

        audioFocusRequest = focusRequest
        val result = audioManager.requestAudioFocus(focusRequest)

        if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            return true
        }

        Log.w("AudioEngine", "Audio focus request was not granted: $result")
        return false
    }

    private fun handleAudioFocusBlocked() {
        // Focus governs playback. Dictation keeps its AudioRecord alive; Android's
        // recording configuration reports real input silencing and restores it after calls.
        if (captureMode == CaptureMode.DICTATION) {
            stopPlayback()
            audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            audioFocusRequest = null
            return
        }
        if (isRecording) {
            stopRecording()
        }
        audioFocusRequest?.let { request ->
            audioManager.abandonAudioFocusRequest(request)
            audioFocusRequest = null
        }
        if (::audioTrack.isInitialized) {
            audioTrack.pause()
        }
        releaseCommunicationRoute()
        audioSampleQueue.clear()
        isPlaying = false
        isRecordingBeforePause = false
        onOutputVolumeCallback?.invoke(0.0F)
        onAudioInterruptionCallback?.let { it("blocked") }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    @SuppressLint("MissingPermission")
    private fun startRecording(requestFocus: Boolean = true): Boolean {
        activateCommunicationRoute()
        if (requestFocus && !requestAudioFocus()) {
            handleAudioFocusBlocked()
            if (captureMode == CaptureMode.CONVERSATION) return false
        }

        val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
        audioRecord = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            SAMPLE_RATE,
            CHANNEL_CONFIG,
            AUDIO_FORMAT,
            bufferSize
        )

        if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
            throw RuntimeException("Audio Record can't initialize!")
        }

        if (AcousticEchoCanceler.isAvailable()){
            echoCanceler = AcousticEchoCanceler.create(audioRecord.audioSessionId)
            if (echoCanceler != null) {
                echoCanceler?.enabled = true
                Log.i("AudioEngine", "Echo Canceler enabled")
            }
        }

        if (NoiseSuppressor.isAvailable()){
            noiseSuppressor = NoiseSuppressor.create(audioRecord.audioSessionId)
            if (noiseSuppressor != null) {
                noiseSuppressor?.enabled = true
                Log.i("AudioEngine", "Noise Suppressor enabled")
            }
        }

        audioRecord.startRecording()
        isRecording = true
        setCaptureSilenced(audioRecord.activeRecordingConfiguration?.isClientSilenced ?: false)
        startMicSampleTap(audioRecord)
        return true
    }

    private fun setCaptureSilenced(silenced: Boolean) {
        if (captureSilenced == silenced) return
        captureSilenced = silenced
        if (silenced) onInputVolumeCallback?.invoke(0.0F)
        onAudioInterruptionCallback?.invoke(if (silenced) "capture_paused" else "capture_resumed")
    }

    private fun startMicSampleTap(recorder: AudioRecord){
        executorServiceMicrophone.execute {
            val buffer = ByteArray(1024)
            try {
                while (isRecording && audioRecord === recorder) {
                    val read = recorder.read(buffer, 0, buffer.size)
                    if (!isRecording || audioRecord !== recorder) break
                    if (read < 0) throw IllegalStateException("AudioRecord read failed: $read")
                    if (read > 0 && !captureSilenced) {
                        val data = buffer.copyOf(read)
                        micEvents += 1
                        micBytes += data.size.toLong()
                        flushBridgeStats("mic")
                        val micVolume = calculateRMSLevel(data)
                        onInputVolumeCallback?.invoke(micVolume)
                        onMicDataCallback?.invoke(data)
                    }
                }
                Log.d("AudioEngine", "Mic sample tap stopped.")
            }catch (e: Exception){
                Log.e("AudioEngine", "Error reading mic sample data", e)
                mainHandler.post {
                    if (isRecording && audioRecord === recorder) {
                        stopRecording()
                        releaseAudioSession()
                        onAudioInterruptionCallback?.invoke("blocked")
                    }
                }
            }
        }
    }

    private fun stopRecording() {
        if (!isRecording) return
        isRecording = false
        if (audioRecord.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
            audioRecord.stop()
        }
        audioRecord.release()
        echoCanceler?.release()
        echoCanceler = null
        noiseSuppressor?.release()
        noiseSuppressor = null
        setCaptureSilenced(false)
        onInputVolumeCallback?.invoke(0.0F)
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    fun startDictation(): Boolean {
        isRecordingBeforePause = false
        if (isRecording) return true
        captureMode = CaptureMode.DICTATION
        return startRecording()
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    fun toggleRecording(value: Boolean): Boolean {
        isRecordingBeforePause = false
        if (value == isRecording) return isRecording

        if (value) {
            captureMode = CaptureMode.CONVERSATION
            return startRecording()
        } else {
            stopRecording()
        }

        isRecording = value
        return isRecording
    }

    @SuppressLint("NewApi")
    fun playPCMData(data: ByteArray) {
        acquireAudioSessionIfNeeded()
        audioTrack.play()
        audioSampleQueue.add(data)
        playbackEvents += 1
        playbackQueuedBytes += data.size.toLong()
        Log.d(
            "AudioEngine",
            "playPCMData queued bytes=${data.size} queueSize=${audioSampleQueue.size} " +
                "head=${data.take(12).joinToString(" ") { byte -> "%02x".format(byte.toInt() and 0xff) }}"
        )
        flushBridgeStats("queue")
        if (!isPlaying) {
            playAudioFromSampleQueue()
        }
    }

    private fun playAudioFromSampleQueue() {
        executorServicePlayback.execute{
            isPlaying = true
            try {
                while (audioSampleQueue.isNotEmpty()){
                    val data = audioSampleQueue.poll()
                    if (data != null){
                        playSample(data)
                        val audioVolume = calculateRMSLevel(data)
                        onOutputVolumeCallback?.invoke(audioVolume)
                    }else{
                        break
                    }
                }
            }catch (e: Exception){
                Log.e("AudioEngine", "Error playing audio", e)
                e.printStackTrace()
            }finally {
                isPlaying = false
                onOutputVolumeCallback?.invoke(0.0F)
            }
        }
    }

    private fun playSample(data: ByteArray) {
        val written = audioTrack.write(data, 0, data.size)
        playbackWrites += 1
        playbackWriteBytes += written.coerceAtLeast(0).toLong()
        Log.d(
            "AudioEngine",
            "playSample wrote=$written requested=${data.size} playState=${audioTrack.playState} " +
                "queueSize=${audioSampleQueue.size}"
        )
        flushBridgeStats("write")
    }

    fun bypassVoiceProcessing(bypass: Boolean) {
        if (bypass) {
            echoCanceler?.enabled = false
            noiseSuppressor?.enabled = false
        } else {
            echoCanceler?.enabled = true
            noiseSuppressor?.enabled = true
        }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    fun pauseRecordingAndPlayer() {
        isRecordingBeforePause = isRecording
        stopRecording()
        audioTrack.pause()
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    fun resumeRecordingAndPlayer() {
        val wasRecordingBeforePause = isRecordingBeforePause
        // Only take the session back if something was actually live when we backgrounded. The
        // activity lifecycle listener calls this on every onResume, so requesting focus
        // unconditionally took focus from the user's music every time the app came to the
        // foreground.
        if (!wasRecordingBeforePause && !isPlaying) {
            return
        }
        isRecordingBeforePause = false
        if (wasRecordingBeforePause) {
            // Returning from music controls must not pause music the user explicitly resumed.
            if (!startRecording(requestFocus = captureMode == CaptureMode.CONVERSATION)) return
        } else {
            activateCommunicationRoute()
            if (!requestAudioFocus()) {
                handleAudioFocusBlocked()
                return
            }
        }
        if (captureMode == CaptureMode.CONVERSATION) audioTrack.play()
    }

    fun stopPlayback() {
        audioSampleQueue.clear()
        audioTrack.pause()
        audioTrack.flush()
        isPlaying = false
        onOutputVolumeCallback?.invoke(0.0F)
        Log.d("AudioEngine", "Playback stopped")
    }

    fun pausePlayback() {
        audioTrack.pause()
        Log.d("AudioEngine", "Playback paused")
    }

    @SuppressLint("NewApi")
    fun resumePlayback() {
        acquireAudioSessionIfNeeded()
        audioTrack.play()
        Log.d("AudioEngine", "Playback resumed")
    }

    @SuppressLint("NewApi")
    fun tearDown() {
        stopRecording()
        audioTrack.stop()
        releaseCommunicationRoute()
        audioFocusRequest?.let { request ->
            audioManager.abandonAudioFocusRequest(request)
        }
        audioFocusRequest = null
        audioManager.unregisterAudioDeviceCallback(deviceCallback)
        audioManager.unregisterAudioRecordingCallback(recordingCallback)
        audioTrack.release()
        executorServiceMicrophone.shutdownNow()
        executorServicePlayback.shutdownNow()
    }


    private fun calculateRMSLevel(buffer: ByteArray): Float {
        val epsilon = 1e-5f // To avoid log(0)

        // Convert ByteArray to FloatArray by treating each pair of bytes as a single 16-bit PCM sample
        val floatBuffer = FloatArray(buffer.size / 2)
        for (i in floatBuffer.indices) {
            // Combine two bytes into a 16-bit signed integer
            val sample = (buffer[i * 2].toInt() or (buffer[i * 2 + 1].toInt() shl 8)).toShort()
            // Normalize sample to -1.0 to 1.0 range for FloatArray
            floatBuffer[i] = sample / 32768.0f
        }

        // Calculate RMS value
        val rmsValue = kotlin.math.sqrt(floatBuffer.fold(0f) { acc, sample -> acc + sample * sample } / floatBuffer.size)

        // Convert to decibels
        val dbValue = 20 * kotlin.math.log10(maxOf(rmsValue, epsilon))

        // Normalize decibel value to 0-1 range
        // Assuming minimum audible is -80dB and maximum is 0dB
        val minDb = -80.0f
        val normalizedValue = maxOf(0.0f, minOf(1.0f, (dbValue - minDb) / kotlin.math.abs(minDb)))

        // Optional: Apply exponential factor to push smaller values down
        val expFactor = 2.0f // Adjust this value to change the curve
        val adjustedValue = normalizedValue.pow(expFactor)

        return adjustedValue
    }

}
