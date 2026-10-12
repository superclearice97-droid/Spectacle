package app.spectacle.local

import android.app.*
import android.content.*
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import android.view.Surface
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android 10+ screen recorder. Each capture requires explicit system consent.
 * Captures low-bitrate H.264 MP4 without microphone audio.
 */
class ScreenRecorderService : Service() {
    companion object {
        const val START = "app.spectacle.local.START_SCREEN"
        const val STOP = "app.spectacle.local.STOP_SCREEN"
        const val RESULT = "result"
        const val DATA = "data"
        const val CHANNEL = "spectacle_screen_record"
    }
    private var projection: MediaProjection? = null
    private var display: android.hardware.display.VirtualDisplay? = null
    private var codec: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var file: File? = null
    private var worker: Thread? = null
    private val running = AtomicBoolean(false)
    private var callback: MediaProjection.Callback? = null

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Spectacle screen recording", NotificationManager.IMPORTANCE_LOW))
    }
    private fun notification() = Notification.Builder(this, CHANNEL)
        .setSmallIcon(app.spectacle.R.drawable.ic_stat_eye)
        .setContentTitle("Spectacle is recording your screen")
        .setContentText("Tap Stop in Spectacle to save the recording")
        .setOngoing(true).build()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { stopCapture(); return START_NOT_STICKY }
        if (intent?.action != START || running.get()) return START_NOT_STICKY
        startForeground(7131, notification())
        val token = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(DATA, Intent::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra<Intent>(DATA)
        if (token == null) { stopSelf(); return START_NOT_STICKY }
        try {
            val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = manager.getMediaProjection(intent.getIntExtra(RESULT, Activity.RESULT_CANCELED), token)
            val p = projection ?: error("Screen permission denied")
            callback = object : MediaProjection.Callback() { override fun onStop() { stopCapture() } }
            p.registerCallback(callback!!, Handler(Looper.getMainLooper()))
            val metrics = resources.displayMetrics
            val width = ((480f * metrics.widthPixels / metrics.heightPixels).toInt().coerceAtLeast(2) / 2) * 2
            val height = 480
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, 400_000)
                setInteger(MediaFormat.KEY_FRAME_RATE, 15)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            }
            val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            codec = encoder
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            val surface: Surface = encoder.createInputSurface()
            file = File(filesDir, "local-recording-screen-${System.currentTimeMillis()}.mp4")
            val m = MediaMuxer(file!!.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            muxer = m
            display = p.createVirtualDisplay("Spectacle event", width, height, metrics.densityDpi,
                android.hardware.display.DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, null)
            running.set(true)
            encoder.start()
            worker = Thread {
                val info = MediaCodec.BufferInfo()
                var track = -1
                var started = false
                try {
                    while (running.get()) {
                        val index = encoder.dequeueOutputBuffer(info, 100_000)
                        if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                            track = m.addTrack(encoder.outputFormat); m.start(); started = true
                        } else if (index >= 0) {
                            if (info.size > 0 && started && track >= 0) {
                                val buffer = encoder.getOutputBuffer(index)!!
                                buffer.position(info.offset); buffer.limit(info.offset + info.size)
                                m.writeSampleData(track, buffer, info)
                            }
                            encoder.releaseOutputBuffer(index, false)
                        }
                    }
                } catch (_: Exception) {
                } finally {
                    runCatching { if (started) m.stop() }
                    runCatching { m.release() }
                    runCatching { encoder.stop(); encoder.release() }
                    val output = file
                    if (output != null && output.length() > 0) {
                        runCatching {
                            val vault = LocalVault(applicationContext)
                            output.inputStream().use { vault.save(it, "video", "Screen event recording") }
                            vault.prune()
                        }.onSuccess { output.delete() }
                    }
                    stopSelf()
                }
            }.apply { name = "spectacle-screen-encoder"; start() }
        } catch (_: Exception) { stopCapture() }
        return START_NOT_STICKY
    }
    private fun stopCapture() {
        if (!running.getAndSet(false)) { stopSelf(); return }
        runCatching { display?.release() }; display = null
        val p = projection; projection = null
        runCatching { callback?.let { p?.unregisterCallback(it) }; p?.stop() }
        if (Thread.currentThread() != worker) worker?.interrupt()
    }
    override fun onDestroy() { stopCapture(); super.onDestroy() }
}
