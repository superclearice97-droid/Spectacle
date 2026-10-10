package app.spectacle

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/** Shows the family's Spectacle server full-screen, with Android permissions, alerts and camera mode wired in. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var prefs: Prefs
    private var pendingPermission: PermissionRequest? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    companion object {
        const val EXTRA_PATH = "path"
        @Volatile var visible = false
        private const val REQ_CAMERA = 1
        private const val REQ_NOTIFY = 2
        private const val REQ_FILE = 3
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val server = prefs.server
        if (server == null) { startActivity(Intent(this, SetupActivity::class.java)); finish(); return }

        web = WebView(this)
        val root = FrameLayout(this)
        root.addView(web)
        offline = buildOfflineScreen()
        root.addView(offline)
        setContentView(root)
        CookieManager.getInstance().setAcceptCookie(true)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            textZoom = (resources.configuration.fontScale * 100).toInt().coerceIn(85, 200) // follow phone's font size
            userAgentString = "$userAgentString SpectacleAndroid/${BuildConfig.VERSION_NAME}"
        }
        web.addJavascriptInterface(Bridge(), "SpectacleAndroid")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (Prefs.originOf(url) == prefs.server) return false
                // Anything else (Wikipedia credits, legal links to other sites) opens in the normal browser.
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {}
                return true
            }
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                val pin = prefs.pin
                val cert = error.certificate?.let { Tls.x509(it) }
                if (pin != null && cert != null && Prefs.originOf(error.url) == prefs.server && Tls.fingerprint(cert) == pin) handler.proceed()
                else handler.cancel()
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // Only the page itself failing matters (not a single image).
                if (request.isForMainFrame) showOffline(true)
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (url.startsWith("http")) showOffline(false)
                maybeOnboard(url)
                val cameraMode = Uri.parse(url).path?.startsWith("/camera") == true
                if (cameraMode) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (Prefs.originOf(request.origin.toString()) != prefs.server || !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                        request.deny(); return@runOnUiThread
                    }
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    else { pendingPermission = request; requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA) }
                }
            }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try { startActivityForResult(params.createIntent(), REQ_FILE); true } catch (e: Exception) { fileCallback = null; false }
            }
        }

        val path = intent.getStringExtra(EXTRA_PATH) ?: "/"
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(server + path)

        startAlerts()
    }

    /** Ask for notifications / background permission only once the person is signed in, never on the sign-up screen. */
    private var onboarded = false
    private fun maybeOnboard(url: String) {
        if (onboarded) return
        val path = Uri.parse(url).path ?: ""
        if (path.startsWith("/camera")) return // a camera phone doesn't need alerts prompts
        val signedIn = CookieManager.getInstance().getCookie(prefs.server)?.contains("sp_session=") == true
        if (!signedIn) return
        onboarded = true
        askNotifications()
        startAlerts()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(EXTRA_PATH)?.let { web.loadUrl(prefs.server + it) }
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); if (::web.isInitialized) web.saveState(outState) }
    override fun onResume() {
        super.onResume(); visible = true
        // Coming back from the Tailscale app: try again straight away.
        if (::offline.isInitialized && offline.visibility == View.VISIBLE) web.reload()
    }

    // ---------- friendly "can't reach home" screen (instead of a browser error page) ----------
    private lateinit var offline: LinearLayout
    private lateinit var offlineText: TextView
    private lateinit var offlineTs: Button

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
    private fun bigButton(text: String, primary: Boolean, onClick: () -> Unit) = Button(this).apply {
        this.text = text; isAllCaps = false; minHeight = dp(64)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f); typeface = Typeface.DEFAULT_BOLD
        setTextColor(getColor(if (primary) R.color.bg else R.color.ink))
        background = GradientDrawable().apply { cornerRadius = dp(16).toFloat(); setColor(getColor(if (primary) R.color.lime else R.color.card)); if (!primary) setStroke(dp(2), getColor(R.color.dim)) }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) }
        setOnClickListener { onClick() }
    }
    private fun buildOfflineScreen() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(28), dp(28), dp(28), dp(28))
        setBackgroundColor(getColor(R.color.bg))
        visibility = View.GONE
        isClickable = true
        addView(TextView(context).apply {
            text = "Can't reach home"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f); typeface = Typeface.DEFAULT_BOLD
            setTextColor(getColor(R.color.ink))
            if (Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
        })
        offlineText = TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 19f); setLineSpacing(0f, 1.25f)
            setTextColor(getColor(R.color.dim))
            setPadding(0, dp(12), 0, dp(8))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        addView(offlineText)
        offlineTs = bigButton("Open Tailscale", true) { TailscaleHelp.open(this@MainActivity) }
        addView(offlineTs)
        addView(bigButton("Try again", false) { showOffline(false); web.reload() })
    }
    private fun showOffline(show: Boolean) {
        if (!::offline.isInitialized) return
        if (show) {
            val ts = TailscaleHelp.usesTailscale(prefs.server)
            offlineText.text = TailscaleHelp.unreachableMessage(this, prefs.server)
            offlineTs.text = TailscaleHelp.buttonLabel(this)
            offlineTs.visibility = if (ts) View.VISIBLE else View.GONE
            offline.visibility = View.VISIBLE
            offline.announceForAccessibility("Can't reach home. " + offlineText.text)
        } else offline.visibility = View.GONE
    }
    override fun onPause() { super.onPause(); visible = false; CookieManager.getInstance().flush() }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (::web.isInitialized && web.canGoBack()) web.goBack() else super.onBackPressed() }

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
        else askBattery()
    }

    /** Alerts only arrive reliably if Android lets the app stay connected. Ask once, in plain words. */
    private fun askBattery() {
        val pm = getSystemService(PowerManager::class.java)
        if (prefs.askedBattery || pm.isIgnoringBatteryOptimizations(packageName) || !prefs.backgroundAlerts) return
        prefs.askedBattery = true
        AlertDialog.Builder(this)
            .setTitle("Get alerts right away")
            .setMessage("So you're told about motion straight away, let Spectacle keep working in the background. On the next screen, tap Allow.")
            .setPositiveButton("Continue") { _, _ -> openBatterySettings() }
            .setNegativeButton("Not now", null)
            .show()
    }

    @SuppressLint("BatteryLife")
    private fun openBatterySettings() {
        try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
        catch (_: Exception) { try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: Exception) {} }
    }

    private fun startAlerts() {
        if (prefs.backgroundAlerts) AlertService.start(this) else AlertService.stop(this)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        val granted = results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED
        when (requestCode) {
            REQ_CAMERA -> { pendingPermission?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else it.deny() }; pendingPermission = null }
            REQ_NOTIFY -> { startAlerts(); askBattery() }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        }
    }

    /** Small set of app features the web pages can use (window.SpectacleAndroid). */
    inner class Bridge {
        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME
        /** Called by the web app once the person is signed in (sign-up doesn't reload the page). */
        @JavascriptInterface fun signedIn() = runOnUiThread { CookieManager.getInstance().flush(); maybeOnboard(web.url ?: "") }
        @JavascriptInterface fun dim(on: Boolean) = runOnUiThread {
            window.attributes = window.attributes.apply { screenBrightness = if (on) 0.01f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE }
        }
        @JavascriptInterface fun backgroundAlerts(): Boolean = prefs.backgroundAlerts
        @JavascriptInterface fun setBackgroundAlerts(on: Boolean) = runOnUiThread { prefs.backgroundAlerts = on; startAlerts() }
        @JavascriptInterface fun batteryOk(): Boolean = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        @JavascriptInterface fun openBattery() = runOnUiThread { openBatterySettings() }
        @JavascriptInterface fun disconnect() = runOnUiThread {
            AlertDialog.Builder(this@MainActivity)
                .setTitle("Disconnect this phone?")
                .setMessage("You'll need an invite link to connect again.")
                .setPositiveButton("Disconnect") { _, _ ->
                    AlertService.stop(this@MainActivity)
                    CookieManager.getInstance().removeAllCookies(null)
                    web.clearCache(true)
                    prefs.clear()
                    startActivity(Intent(this@MainActivity, SetupActivity::class.java))
                    finish()
                }
                .setNegativeButton("Cancel", null)
                .show()
        }
    }
}
