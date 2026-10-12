package app.spectacle

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.webkit.CookieManager
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * Keeps one quiet connection to the family's own server and turns motion / new-species messages into
 * phone notifications. No Google or other push service is involved.
 */
class AlertService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var backoff = 2000L
    private var stopped = false
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private var nextId = 100

    companion object {
        private const val CH_ALERTS = "alerts"
        private const val CH_STATUS = "status"
        private const val STATUS_ID = 1
        fun start(ctx: Context) {
            val prefs = Prefs(ctx)
            if (prefs.standalone || prefs.server == null) return
            try { ctx.startForegroundService(Intent(ctx, AlertService::class.java)) } catch (_: Exception) {}
        }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, AlertService::class.java)) }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_ALERTS, "Motion & wildlife alerts", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "When a camera sees movement or a new species"
            enableVibration(true)
        })
        nm.createNotificationChannel(NotificationChannel(CH_STATUS, "Connection status", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Shows that Spectacle is watching for alerts. You can hide this one."
            setShowBadge(false)
        })
        val status = Notification.Builder(this, CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat_eye)
            .setContentTitle("Watching for alerts")
            .setContentText("Tap to open Spectacle")
            .setContentIntent(openIntent("/"))
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(STATUS_ID, status, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(STATUS_ID, status)

        val cm = getSystemService(ConnectivityManager::class.java)
        netCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { main.post { if (socket == null) { backoff = 2000; connect() } } }
        }
        try { cm.registerDefaultNetworkCallback(netCallback!!) } catch (_: Exception) {}
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Prefs(this).standalone) { stopSelf(); return START_NOT_STICKY }
        // Started again (e.g. right after signing in): connect now instead of waiting for the next retry.
        main.post { if (socket == null) { backoff = 2000; connect() } }
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        socket?.close(1000, null)
        netCallback?.let { try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } catch (_: Exception) {} }
        super.onDestroy()
    }

    private fun connect() {
        if (stopped || socket != null) return
        val prefs = Prefs(this)
        if (prefs.standalone) return stopSelf()
        val server = prefs.server ?: return stopSelf()
        val cookie = CookieManager.getInstance().getCookie(server)
        if (cookie.isNullOrEmpty()) { retry(); return } // not signed in yet
        val req = Request.Builder().url(server.replaceFirst("https://", "wss://") + "/ws?background=1").header("Cookie", cookie).build()
        socket = Tls.client(prefs.pin).newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { backoff = 2000; main.post { connected() } }
            override fun onMessage(webSocket: WebSocket, text: String) { main.post { handle(text) } }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { main.post { lost(webSocket) } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { main.post { lost(webSocket) } }
        })
    }

    private fun lost(ws: WebSocket) {
        if (socket === ws) { socket = null; retry() }
        if (downSince == 0L) downSince = System.currentTimeMillis()
        // Tell the person (gently, once) if home has been unreachable for a while: usually Tailscale is off.
        if (!warned && System.currentTimeMillis() - downSince > 10 * 60_000) { warned = true; setStatus(false) }
    }
    private var downSince = 0L
    private var warned = false
    private fun connected() { downSince = 0; if (warned) { warned = false; setStatus(true) } }

    private fun setStatus(ok: Boolean) {
        val server = Prefs(this).server
        val ts = TailscaleHelp.usesTailscale(server)
        val b = Notification.Builder(this, CH_STATUS).setSmallIcon(R.drawable.ic_stat_eye).setOngoing(true)
        if (ok) b.setContentTitle("Watching for alerts").setContentText("Tap to open Spectacle").setContentIntent(openIntent("/"))
        else {
            val tap = if (ts) PendingIntent.getActivity(this, 7, packageManager.getLaunchIntentForPackage(TailscaleHelp.PACKAGE) ?: Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE) else openIntent("/")
            b.setContentTitle("Not receiving alerts").setContentText(if (ts) "Can't reach home. Tap to check Tailscale is switched on." else "Can't reach home. Check your connection.").setContentIntent(tap)
        }
        try { getSystemService(NotificationManager::class.java).notify(STATUS_ID, b.build()) } catch (_: SecurityException) {}
    }
    private fun retry() {
        if (stopped) return
        main.postDelayed({ connect() }, backoff)
        backoff = (backoff * 2).coerceAtMost(60_000)
    }

    private fun handle(text: String) {
        val m = try { JSONObject(text) } catch (_: Exception) { return }
        when (m.optString("type")) {
            "alert" -> notify(m.optString("title", "Spectacle"), m.optString("body"), m.optString("url", "/").removePrefix("/").let { "/$it" })
            "sighting" -> if (m.optBoolean("isNew")) {
                val sp = m.optJSONObject("species")
                val name = sp?.optString("common")?.takeIf { it.isNotEmpty() } ?: sp?.optString("scientific") ?: "a new species"
                notify("New in the yard: $name", "Spotted by ${m.optString("cam")}", "/#biome/" + (sp?.optString("id") ?: ""))
            }
        }
    }

    private fun notify(title: String, body: String, path: String) {
        if (MainActivity.visible) return // the open app already shows it
        val n = Notification.Builder(this, CH_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_eye)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(openIntent(path))
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_ALARM)
            .build()
        try { getSystemService(NotificationManager::class.java).notify(nextId++, n) } catch (_: SecurityException) {}
    }

    private fun openIntent(path: String): PendingIntent {
        val i = Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_PATH, path).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(this, path.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
