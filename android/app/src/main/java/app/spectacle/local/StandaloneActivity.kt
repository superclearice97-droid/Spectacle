package app.spectacle.local

import android.Manifest
import android.app.AlertDialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.*
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import app.spectacle.AlertService
import app.spectacle.Prefs
import app.spectacle.R
import app.spectacle.SetupActivity
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

/** Native local camera/recorder/biome app. No server, account, PC, internet or pairing required. */
class StandaloneActivity : ComponentActivity() {
    private lateinit var vault: LocalVault
    private lateinit var identifier: LocalIdentifier
    private lateinit var content: LinearLayout
    private lateinit var message: TextView
    private val main = Handler(Looper.getMainLooper())
    private val analysisWorker = Executors.newSingleThreadExecutor()
    private val classifying = AtomicBoolean(false)
    private var provider: ProcessCameraProvider? = null
    private var capture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null
    private var finalizePending = false
    private var preview: PreviewView? = null
    @Volatile private var monitor = false
    @Volatile private var resumed = false
    private var currentPage = "Home"
    private var lens = CameraSelector.LENS_FACING_BACK
    private var previous: IntArray? = null
    private var lastAnalysis = 0L
    private var lastMotion = 0L
    private var lastScan = 0L
    private var exportItem: JSONObject? = null
    private var playbackFile: File? = null
    private var playbackView: VideoView? = null
    private var recordButton: Button? = null
    private val settings by lazy { getSharedPreferences("spectacle-local", MODE_PRIVATE) }
    private val repeatSegment = Runnable { if (monitor && resumed && recording != null) { recording?.stop() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AlertService.stop(this)
        Prefs(this).standalone = true
        try { vault = LocalVault(this) } catch (e: Exception) {
            AlertDialog.Builder(this).setTitle("Can't open the local archive").setMessage(e.message)
                .setPositiveButton("Close") { _, _ -> finish() }.setCancelable(false).show(); return
        }
        identifier = LocalIdentifier(applicationContext)
        // Android's cache is private, but old playback plaintext should not linger after a crash.
        cacheDir.listFiles()?.filter { it.name.startsWith("spectacle-playback-") }?.forEach { it.delete() }
        LocalVault.io.execute {
            // Seal any interrupted recording left in private storage after a process kill.
            filesDir.listFiles()?.filter { it.name.startsWith("local-recording-") && it.extension == "mp4" && it.path !in LocalVault.activeRecordings }?.forEach { file ->
                runCatching { if (file.length() > 0) file.inputStream().use { vault.save(it, "video", "Recovered recording (may be incomplete)") } }
                    .onSuccess { file.delete() }
                    .onFailure { onMain { say("An interrupted recording could not be recovered: ${it.message}") } }
            }
            runCatching { vault.prune() }
        }
        showPage("Home")
    }
    private fun dp(n: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, n.toFloat(), resources.displayMetrics).toInt()
    private fun text(value: String, size: Float = 18f) = TextView(this).apply {
        this.text = value; textSize = size; setTextColor(getColor(R.color.ink)); setPadding(0, dp(8), 0, dp(8))
    }
    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; minHeight = dp(52); setOnClickListener { action() }
    }
    private fun say(value: String) { if (!isDestroyed && ::message.isInitialized) message.text = value }
    private fun onMain(action: () -> Unit) { main.post { if (!isDestroyed && !isFinishing) action() } }
    private fun buildShell(page: String) {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(18), dp(20), dp(18), dp(10)); setBackgroundColor(getColor(R.color.bg)) }
        root.addView(text("Spectacle · This phone", 26f))
        root.addView(text("Independent mode · stored on this device", 14f))
        val tabs = LinearLayout(this)
        listOf("Home", "Camera", "Archive", "Biome", "Settings").forEach { title ->
            tabs.addView(button(title) { showPage(title) }, LinearLayout.LayoutParams(0, dp(54), 1f))
        }
        // Horizontal scrolling preserves readable controls with large accessibility fonts.
        root.addView(HorizontalScrollView(this).apply { addView(tabs); isFillViewport = true })
        message = text("", 15f).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        root.addView(message)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(ScrollView(this).apply { addView(content); isFillViewport = true }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root); currentPage = page
    }
    private fun showPage(page: String) {
        stopCamera()
        stopPlayback(); buildShell(page)
        when (page) {
            "Home" -> {
                content.addView(text("Your phone is the camera and the recorder.", 24f))
                content.addView(text("Watch its live camera, save videos and motion snapshots, and identify birds, insects and plants without an internet connection."))
                content.addView(button("Open this phone's camera") { showPage("Camera") })
                content.addView(button("View local recordings and events") { showPage("Archive") })
                content.addView(text("Camera monitoring runs while this screen is open. Leaving the camera screen or putting the app in the background stops capture and finalizes the current recording. Audio is disabled.", 16f))
                loadEntries { entries -> say("${entries.size} saved items · 7-day retention · 500 MB archive limit") }
            }
            "Camera" -> cameraPage()
            "Archive" -> archivePage(false)
            "Biome" -> archivePage(true)
            "Settings" -> settingsPage()
        }
    }
    private fun cameraPage() {
        preview = PreviewView(this).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
        content.addView(preview, LinearLayout.LayoutParams(-1, dp(300)))
        content.addView(button("Start camera") { startWithConsent() })
        content.addView(button("Stop camera") { stopCamera(); say("Camera stopped. Saved items stay in Archive.") })
        recordButton = button("Start recording") { if (recording == null) startRecording() else stopRecording(false) }
        content.addView(recordButton)
        content.addView(button("Save a photo / identify") {
            if (!monitor) say("Start the camera first.") else {
                val bitmap = preview?.bitmap
                if (bitmap == null) say("No frame yet. Try again in a moment.")
                else queueSnapshot(bitmap, "photo", true)
            }
        })
        content.addView(button("Switch front / rear camera") {
            if (recording != null || finalizePending) { say("Stop recording before switching cameras."); return@button }
            lens = if (lens == CameraSelector.LENS_FACING_BACK) CameraSelector.LENS_FACING_FRONT else CameraSelector.LENS_FACING_BACK
            if (monitor) bindCamera()
        })
        content.addView(text("Motion snapshots and automatic biome scans are saved locally. Recordings use silent MP4 segments of up to one minute. Keep this screen open while monitoring.", 16f))
    }
    private fun startWithConsent() {
        if (settings.getBoolean("placement", false)) ensurePermission()
        else AlertDialog.Builder(this).setTitle("Before recording")
            .setMessage("Only point cameras at places you are allowed to record. Tell household members and guests. Do not record other people's private spaces. Audio is disabled.")
            .setPositiveButton("I agree") { _, _ -> settings.edit().putBoolean("placement", true).apply(); ensurePermission() }
            .setNegativeButton("Cancel", null).show()
    }
    private fun ensurePermission() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(Manifest.permission.CAMERA), 51)
        else startCamera()
    }
    @Deprecated("Deprecated in Java")
    override fun onRequestPermissionsResult(code: Int, permissions: Array<String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == 51) {
            if (results.firstOrNull() == PackageManager.PERMISSION_GRANTED && resumed && currentPage == "Camera") startCamera()
            else say("Camera permission is needed to use this phone's camera.")
        }
    }
    private fun startCamera() {
        if (!resumed || currentPage != "Camera") return
        monitor = true
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            if (!monitor || !resumed || isDestroyed) return@addListener
            try { provider = future.get(); bindCamera() } catch (e: Exception) { stopCamera(); say("Camera unavailable: ${e.message}") }
        }, ContextCompat.getMainExecutor(this))
    }
    private fun bindCamera() {
        val p = provider ?: return
        previous = null
        p.unbindAll()
        val selector = CameraSelector.Builder().requireLensFacing(lens).build()
        val view = Preview.Builder().build().also { it.setSurfaceProvider(preview?.surfaceProvider) }
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        analysis.setAnalyzer(analysisWorker) { image -> analyze(image) }
        val video = VideoCapture.withOutput(Recorder.Builder().setQualitySelector(QualitySelector.from(Quality.SD, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD))).build())
        try {
            p.bindToLifecycle(this, selector, view, analysis, video); capture = video
            say("Live · local motion detection and offline species scans")
        } catch (_: Exception) {
            try {
                p.unbindAll(); p.bindToLifecycle(this, selector, view, analysis); capture = null
                say("Live · this camera supports photos and motion, but not simultaneous video recording.")
            } catch (e: Exception) { stopCamera(); say("Camera unavailable: ${e.message}") }
        }
    }
    private fun analyze(image: ImageProxy) {
        try {
            if (!monitor || !resumed) return
            val now = System.currentTimeMillis()
            if (now - lastAnalysis < 500) return
            lastAnalysis = now
            val plane = image.planes[0]; val buffer = plane.buffer
            val gray = IntArray(32 * 24)
            for (y in 0 until 24) for (x in 0 until 32) {
                val pos = (y * image.height / 24) * plane.rowStride + (x * image.width / 32) * plane.pixelStride
                gray[y * 32 + x] = buffer.get(pos).toInt() and 255
            }
            val prev = previous; previous = gray
            val threshold = settings.getInt("threshold", 18)
            val moved = prev != null && gray.indices.count { abs(gray[it] - prev[it]) > threshold } > gray.size / 12
            val motion = settings.getBoolean("motion", true) && moved && now - lastMotion > 15000
            val scan = settings.getBoolean("biome", true) && now - lastScan > 60000
            if ((motion || scan) && classifying.compareAndSet(false, true)) {
                if (motion) lastMotion = now
                if (scan) lastScan = now
                var bitmap: Bitmap? = null
                try {
                    bitmap = image.toBitmap()
                    if (image.imageInfo.rotationDegrees != 0) {
                        val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(image.imageInfo.rotationDegrees.toFloat()) }, true)
                        if (rotated !== bitmap) bitmap.recycle()
                        bitmap = rotated
                    }
                    saveSnapshot(bitmap, if (motion) "motion" else "sighting", settings.getBoolean("biome", true))
                } finally { bitmap?.recycle(); classifying.set(false) }
            }
        } catch (e: Exception) { onMain { say("Snapshot could not be saved: ${e.message}") } }
        finally { image.close() }
    }
    private fun queueSnapshot(bitmap: Bitmap, kind: String, classify: Boolean) {
        if (!classifying.compareAndSet(false, true)) { bitmap.recycle(); say("Still processing the previous photo."); return }
        say("Processing on this phone…")
        analysisWorker.execute {
            try { saveSnapshot(bitmap, kind, classify) }
            catch (e: Exception) { onMain { say("Could not save photo: ${e.message}") } }
            finally { bitmap.recycle(); classifying.set(false) }
        }
    }
    private fun saveSnapshot(bitmap: Bitmap, kind: String, classify: Boolean) {
        val guesses = if (classify) identifier.identify(bitmap) else emptyList()
        val best = guesses.firstOrNull()
        val confident = best != null && best.confidence >= 0.6f
        if (kind == "sighting" && !confident) return
        val details = guesses.joinToString("\n") { "${it.label} (${it.group}): ${(it.confidence * 100).toInt()}%" }
        val title = if (confident) best!!.label else if (kind == "motion") "Motion detected" else "Photo — identification uncertain"
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
        LocalVault.io.execute {
            try {
                val item = vault.save(ByteArrayInputStream(bytes), kind, title, details)
                onMain {
                    say("Saved: $title")
                    if (kind == "motion") notifyMotion(item)
                }
            } catch (e: Exception) { onMain { say("Archive error: ${e.message}") } }
        }
    }
    private fun notifyMotion(item: JSONObject) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("local-motion", "Local motion", NotificationManager.IMPORTANCE_DEFAULT))
        manager.notify(item.getString("id").hashCode(), android.app.Notification.Builder(this, "local-motion")
            .setSmallIcon(R.drawable.ic_stat_eye).setContentTitle("Motion on this phone").setContentText(item.getString("title")).setAutoCancel(true).build())
    }
    private fun startRecording() {
        val video = capture
        if (!monitor || !resumed || video == null) { say("Start a camera that supports recording first."); return }
        if (finalizePending) { say("Finishing the last segment…"); return }
        if (filesDir.usableSpace < 150L * 1024 * 1024) { say("Not enough free storage. Free at least 150 MB to record."); return }
        val file = File(filesDir, "local-recording-${System.currentTimeMillis()}.mp4")
        LocalVault.activeRecordings.add(file.path)
        try {
            finalizePending = true
            recording = video.output.prepareRecording(this, FileOutputOptions.Builder(file).setFileSizeLimit(40L * 1024 * 1024).build())
                .start(ContextCompat.getMainExecutor(this)) { event ->
                    if (event is VideoRecordEvent.Start) { recordButton?.text = "Stop recording"; say("REC · silent video stored on this phone") }
                    if (event is VideoRecordEvent.Finalize) {
                        recording = null; finalizePending = false; recordButton?.text = "Start recording"
                        val usable = !event.hasError() || event.error == VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED || event.error == VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE
                        LocalVault.io.execute {
                            var archived = false
                            try {
                                if (usable && file.length() > 0) {
                                    file.inputStream().use { vault.save(it, "video", "Camera recording") }
                                    archived = true
                                } else onMain { say("Recording did not complete (error ${event.error}).") }
                            } catch (e: Exception) { onMain { say("Recording could not be archived: ${e.message}. It will be retried when you reopen the app.") } }
                            finally {
                                if (archived || !usable || file.length() == 0L) file.delete()
                                LocalVault.activeRecordings.remove(file.path)
                            }
                        }
                        if (monitor && resumed && settings.getBoolean("continuous", false) && usable && !isDestroyed) startRecording()
                    }
                }
            settings.edit().putBoolean("continuous", true).apply()
            main.removeCallbacks(repeatSegment); main.postDelayed(repeatSegment, 60000)
        } catch (e: Exception) { finalizePending = false; recording = null; file.delete(); LocalVault.activeRecordings.remove(file.path); say("Recording failed: ${e.message}") }
    }
    private fun stopRecording(continuous: Boolean) {
        settings.edit().putBoolean("continuous", continuous).apply(); main.removeCallbacks(repeatSegment)
        recording?.stop(); recording = null
        recordButton?.text = "Start recording"
    }
    private fun stopCamera() {
        monitor = false; stopRecording(false)
        provider?.unbindAll(); capture = null
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
    private fun loadEntries(done: (List<JSONObject>) -> Unit) {
        val page = currentPage
        LocalVault.io.execute {
            try { val entries = vault.entries(); onMain { if (currentPage == page) done(entries) } }
            catch (e: Exception) { onMain { say("Archive could not be read: ${e.message}") } }
        }
    }
    private fun archivePage(biomeOnly: Boolean) {
        if (biomeOnly) {
            content.addView(text("Offline biome log", 24f))
            content.addView(text("Bundled models recognize a limited set of birds, insects and plants. Confidence is an estimate, not a verified identification. Only automatic scans at 60% confidence or higher are logged."))
            content.addView(button("Identify a saved photo") {
                startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply { type = "image/*"; addCategory(Intent.CATEGORY_OPENABLE) }, 53)
            })
        }
        loadEntries { all ->
            val entries = if (biomeOnly) all.filter { it.getString("detail").isNotBlank() } else all
            say("${entries.size} items · saved only on this phone")
            if (entries.isEmpty()) content.addView(text("Nothing saved yet. Open Camera to start."))
            entries.forEach { item ->
                content.addView(text("${item.getString("title")}\n${DateFormat.getDateTimeInstance().format(Date(item.getLong("time")))} · ${item.getString("kind")}"))
                if (item.optString("detail").isNotBlank()) content.addView(text(item.getString("detail"), 15f))
                val actions = LinearLayout(this)
                actions.addView(button("View") { viewItem(item) }, LinearLayout.LayoutParams(0, -2, 1f))
                actions.addView(button("Export") { exportItem = item; startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = if (item.getString("kind") == "video") "video/mp4" else "image/jpeg"
                    putExtra(Intent.EXTRA_TITLE, "Spectacle-${item.getString("id")}.${if (item.getString("kind") == "video") "mp4" else "jpg"}")
                }, 52) }, LinearLayout.LayoutParams(0, -2, 1f))
                actions.addView(button("Delete") { AlertDialog.Builder(this).setTitle("Delete this local item?").setMessage("This cannot be undone.")
                    .setPositiveButton("Delete") { _, _ -> LocalVault.io.execute { try { vault.remove(item.getString("id")); onMain { showPage(currentPage) } } catch (e: Exception) { onMain { say(e.message ?: "Delete failed") } } } }
                    .setNegativeButton("Cancel", null).show() }, LinearLayout.LayoutParams(0, -2, 1f))
                content.addView(actions)
            }
        }
    }
    private fun viewItem(item: JSONObject) {
        stopPlayback()
        LocalVault.io.execute {
            try {
                if (item.getString("kind") == "video") {
                    val file = File(cacheDir, "spectacle-playback-${item.getString("id")}.mp4")
                    vault.open(item.getString("id")).use { input -> file.outputStream().use { input.copyTo(it) } }
                    onMain {
                        playbackFile = file
                        val view = VideoView(this); playbackView = view
                        val controller = MediaController(this); controller.setAnchorView(view); view.setMediaController(controller)
                        val frame = FrameLayout(this).apply { addView(view, FrameLayout.LayoutParams(-1, dp(350), Gravity.CENTER)) }
                        val dialog = AlertDialog.Builder(this).setTitle(item.getString("title")).setView(frame).setPositiveButton("Close", null).create()
                        dialog.setOnDismissListener { stopPlayback() }; dialog.show(); view.setVideoPath(file.path); view.start()
                    }
                    if (isDestroyed || isFinishing) file.delete()
                } else {
                    val bitmap = vault.open(item.getString("id")).use { BitmapFactory.decodeStream(it) } ?: error("Can't decode this photo")
                    onMain {
                        val view = ImageView(this).apply { setImageBitmap(bitmap); adjustViewBounds = true }
                        val dialog = AlertDialog.Builder(this).setTitle(item.getString("title")).setView(view).setPositiveButton("Close", null).create()
                        dialog.setOnDismissListener { view.setImageDrawable(null); bitmap.recycle() }; dialog.show()
                    }
                }
            } catch (e: Exception) { onMain { say("Could not open item: ${e.message}") } }
        }
    }
    private fun stopPlayback() { playbackView?.stopPlayback(); playbackView = null; playbackFile?.delete(); playbackFile = null }
    private fun settingsPage() {
        fun toggle(label: String, key: String, default: Boolean) { content.addView(Switch(this).apply {
            text = label; textSize = 18f; setTextColor(getColor(R.color.ink)); isChecked = settings.getBoolean(key, default)
            setOnCheckedChangeListener { _, on -> settings.edit().putBoolean(key, on).apply() }
        }) }
        toggle("Save motion snapshots", "motion", true)
        toggle("Automatic offline biome scans", "biome", true)
        content.addView(text("Motion sensitivity (higher detects smaller changes)", 16f))
        content.addView(SeekBar(this).apply { max = 30; progress = 40 - settings.getInt("threshold", 18)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: SeekBar?, value: Int, fromUser: Boolean) { settings.edit().putInt("threshold", 40 - value).apply() }
                override fun onStartTrackingTouch(bar: SeekBar?) {}
                override fun onStopTrackingTouch(bar: SeekBar?) {}
            })
        })
        content.addView(button("Enable local motion notifications") {
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 54)
            else say("Local motion notifications are enabled in Android notification settings.")
        })
        content.addView(text("Completed footage, photos and archive metadata use AES-GCM with an Android Keystore key. The current recording is temporarily plaintext in private app storage; exports are plaintext in the location you choose. Uninstalling deletes the local archive and its key. Export items you want to keep.", 16f))
        content.addView(text("The archive automatically removes items older than 7 days and the oldest items above 500 MB. This mode uses this phone's camera. IP cameras and family sharing are available in optional shared-server mode.", 16f))
        content.addView(button("Connect to a shared server (optional)") {
            Prefs(this).standalone = false
            startActivity(Intent(this, SetupActivity::class.java)); finish()
        })
    }
    @Deprecated("Deprecated in Java")
    override fun onActivityResult(code: Int, result: Int, data: Intent?) {
        super.onActivityResult(code, result, data)
        val uri = data?.data
        if (code == 52) {
            val item = exportItem; exportItem = null
            if (result != RESULT_OK || uri == null || item == null) return
            LocalVault.io.execute {
                try { vault.open(item.getString("id")).use { input -> contentResolver.openOutputStream(uri)?.use { input.copyTo(it) } ?: error("Can't open export destination") }; onMain { say("Export saved.") } }
                catch (e: Exception) { onMain { say("Export failed: ${e.message}") } }
            }
        }
        if (code == 53 && result == RESULT_OK && uri != null) {
            analysisWorker.execute {
                var bitmap: Bitmap? = null
                try {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
                    val options = BitmapFactory.Options().apply { inSampleSize = 1; while (bounds.outWidth / inSampleSize > 1600 || bounds.outHeight / inSampleSize > 1600) inSampleSize *= 2 }
                    bitmap = contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: error("Unsupported image")
                    saveSnapshot(bitmap, "photo", true)
                } catch (e: Exception) { onMain { say("Photo could not be identified: ${e.message}") } }
                finally { bitmap?.recycle() }
            }
        }
    }
    override fun onResume() { super.onResume(); resumed = true }
    override fun onPause() { resumed = false; if (::content.isInitialized) stopCamera(); stopPlayback(); super.onPause() }
    override fun onDestroy() {
        if (::content.isInitialized) stopCamera()
        stopPlayback(); main.removeCallbacksAndMessages(null)
        if (::identifier.isInitialized) analysisWorker.execute { identifier.close() }
        analysisWorker.shutdown(); super.onDestroy()
    }
}
