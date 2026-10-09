package app.spectacle

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts alerts after the phone reboots or the app updates, so nobody has to remember to open it. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            if (Prefs(context).backgroundAlerts) AlertService.start(context)
        }
    }
}
