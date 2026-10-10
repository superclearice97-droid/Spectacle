package app.spectacle

import android.content.Context
import android.content.Intent
import android.net.Uri

/** Plain-language help for the one extra app family members need: Tailscale (the private connection home). */
object TailscaleHelp {
    const val PACKAGE = "com.tailscale.ipn"
    private const val PLAY = "https://play.google.com/store/apps/details?id=$PACKAGE"

    /** True when the server is only reachable through Tailscale (a *.ts.net name or a 100.x address). */
    fun usesTailscale(server: String?): Boolean {
        val host = server?.let { Uri.parse(it).host } ?: return false
        if (host.endsWith(".ts.net")) return true
        val p = host.split(".").mapNotNull { it.toIntOrNull() }
        return p.size == 4 && p[0] == 100 && p[1] in 64..127
    }

    fun installed(ctx: Context): Boolean =
        try { ctx.packageManager.getPackageInfo(PACKAGE, 0); true } catch (_: Exception) { false }

    /** Opens Tailscale if it's installed, otherwise its Play Store page. */
    fun open(ctx: Context) {
        val launch = ctx.packageManager.getLaunchIntentForPackage(PACKAGE)
        val intent = launch ?: try { Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$PACKAGE")) } catch (_: Exception) { null }
        try { ctx.startActivity((intent ?: Intent(Intent.ACTION_VIEW, Uri.parse(PLAY))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        catch (_: Exception) { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PLAY)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    fun buttonLabel(ctx: Context) = if (installed(ctx)) "Open Tailscale" else "Get Tailscale"

    fun unreachableMessage(ctx: Context, server: String?): String = when {
        !usesTailscale(server) -> "Couldn't reach your family's cameras. Check you're connected to the internet (or your home Wi-Fi), then try again."
        !installed(ctx) -> "Spectacle needs the Tailscale app to reach your family's cameras privately. Tap \"Get Tailscale\", install it and sign in, then come back."
        else -> "Couldn't reach your family's cameras. Open Tailscale and make sure it's switched on (Connected), then try again."
    }
}
