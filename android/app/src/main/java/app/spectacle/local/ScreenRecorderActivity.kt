package app.spectacle.local

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.ArrayAdapter
import android.widget.TextView
import androidx.activity.ComponentActivity

/** Explicit user-triggered screen capture permission and controls. */
class ScreenRecorderActivity : ComponentActivity() {
    private val requestCode = 814
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 48, 32, 24) }
        root.addView(TextView(this).apply { text = "Screen Event Recorder · 480p / 15 FPS\n\nRecordings stay on this phone. Android will ask for permission every time you start." ; textSize = 19f })
        val profiles = arrayOf("Compact · 360p / 10 FPS", "Balanced · 480p / 15 FPS", "Clear · 720p / 15 FPS")
        val selector = Spinner(this).apply { adapter = ArrayAdapter(this@ScreenRecorderActivity, android.R.layout.simple_spinner_dropdown_item, profiles); setSelection(1) }
        root.addView(selector)
        root.addView(Button(this).apply { text = "Start screen recording"; setOnClickListener {
            val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            getPreferences(MODE_PRIVATE).edit().putInt("profile", selector.selectedItemPosition).apply()
            startActivityForResult(manager.createScreenCaptureIntent(), requestCode)
        } })
        root.addView(Button(this).apply { text = "Stop and save"; setOnClickListener {
            startService(Intent(this@ScreenRecorderActivity, ScreenRecorderService::class.java).setAction(ScreenRecorderService.STOP))
        } })
        root.addView(Button(this).apply { text = "Back to Spectacle"; setOnClickListener { finish() } })
        setContentView(root)
    }
    @Deprecated("Android result callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == this.requestCode && resultCode == Activity.RESULT_OK && data != null) {
            startForegroundService(Intent(this, ScreenRecorderService::class.java).apply {
                action = ScreenRecorderService.START
                putExtra(ScreenRecorderService.RESULT, resultCode)
                putExtra(ScreenRecorderService.DATA, data)
                putExtra(ScreenRecorderService.PROFILE, getPreferences(MODE_PRIVATE).getInt("profile", 1))
            })
        }
    }
}
