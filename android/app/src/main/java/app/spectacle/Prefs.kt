package app.spectacle

import android.content.Context
import android.net.Uri

/** Where this phone's Spectacle server is, and the certificate pin for home-network (self-signed) servers. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("spectacle", Context.MODE_PRIVATE)

    var server: String?
        get() = sp.getString("server", null)
        set(v) { sp.edit().putString("server", v).apply() }

    /** SHA-256 of the server certificate (lowercase hex), only for self-signed servers. */
    var pin: String?
        get() = sp.getString("pin", null)?.takeIf { it.isNotEmpty() }
        set(v) { sp.edit().putString("pin", v ?: "").apply() }

    var backgroundAlerts: Boolean
        get() = sp.getBoolean("alerts", true)
        set(v) { sp.edit().putBoolean("alerts", v).apply() }

    var askedBattery: Boolean
        get() = sp.getBoolean("askedBattery", false)
        set(v) { sp.edit().putBoolean("askedBattery", v).apply() }

    fun clear() { sp.edit().clear().apply() }

    companion object {
        /** "https://host:port" for any URL. */
        fun originOf(url: String): String? = try {
            val u = Uri.parse(url)
            if (u.scheme != "https" || u.host.isNullOrEmpty()) null
            else "https://" + u.host + (if (u.port > 0) ":" + u.port else "")
        } catch (e: Exception) { null }
    }
}
