package app.spectacle

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import okhttp3.Request

/**
 * First-run screen. The person only has to paste (or share, or tap) the invite link they were sent.
 * Big text, big buttons, works with TalkBack and the phone's font size.
 */
class SetupActivity : Activity() {
    private lateinit var input: EditText
    private lateinit var status: TextView
    private lateinit var connect: Button
    private lateinit var tsButton: Button
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        if (::tsButton.isInitialized && tsButton.visibility == View.VISIBLE && input.text.isNotBlank()) { tsButton.visibility = View.GONE; go() }
    }

    private fun handle(intent: Intent?) {
        val text = when (intent?.action) {
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
            Intent.ACTION_VIEW -> intent.data?.getQueryParameter("link")
            else -> null
        }
        if (!text.isNullOrBlank()) { input.setText(text); go() }
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
    private fun color(id: Int) = getColor(id)

    private fun bigButton(text: String, primary: Boolean): Button = Button(this).apply {
        this.text = text
        isAllCaps = false
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        typeface = Typeface.DEFAULT_BOLD
        minHeight = dp(64)
        setTextColor(if (primary) color(R.color.bg) else color(R.color.ink))
        background = GradientDrawable().apply {
            cornerRadius = dp(16).toFloat()
            setColor(if (primary) color(R.color.lime) else color(R.color.card))
            if (!primary) setStroke(dp(2), color(R.color.dim))
        }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) }
    }

    private fun label(text: String, sp: Float, c: Int, bold: Boolean = false) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(c)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        setLineSpacing(0f, 1.25f)
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) }
    }

    private fun buildUi(): View {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(40), dp(24), dp(32))
        }
        col.addView(TextView(this).apply {
            setCompoundDrawablesRelativeWithIntrinsicBounds(0, R.mipmap.ic_launcher, 0, 0)
            gravity = Gravity.START
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        })
        col.addView(label("Welcome to Spectacle", 30f, color(R.color.ink), true).apply { isFocusable = true; accessibilityHeading() })
        col.addView(label("Use this phone on its own, or optionally connect to a family's server.", 19f, color(R.color.dim)))
        col.addView(bigButton("Use this phone independently", true).apply {
            setOnClickListener {
                AlertService.stop(this@SetupActivity)
                Prefs(this@SetupActivity).standalone = true
                startActivity(Intent(this@SetupActivity, app.spectacle.local.StandaloneActivity::class.java))
                finish()
            }
        })
        col.addView(label("Optional shared server", 22f, color(R.color.ink), true))
        col.addView(label("To connect, use the invite link you were sent by text or email.", 19f, color(R.color.dim)))
        col.addView(label("Easiest way: copy the whole message, then tap the button below.", 19f, color(R.color.dim)))

        col.addView(bigButton("Paste my invite", true).apply {
            contentDescription = "Paste my invite link from the clipboard and connect"
            setOnClickListener { pasteAndGo() }
        })

        col.addView(label("Or paste it here yourself:", 17f, color(R.color.dim)).apply { (layoutParams as LinearLayout.LayoutParams).topMargin = dp(28) })
        input = EditText(this).apply {
            hint = "Invite link"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            setTextColor(color(R.color.ink))
            setHintTextColor(color(R.color.dim))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minHeight = dp(56)
            contentDescription = "Invite link"
        }
        col.addView(input)
        connect = bigButton("Connect", false).apply { setOnClickListener { go() } }
        col.addView(connect)

        status = label("", 19f, color(R.color.ink)).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            (layoutParams as LinearLayout.LayoutParams).topMargin = dp(22)
        }
        col.addView(status)
        tsButton = bigButton("Open Tailscale", true).apply {
            visibility = View.GONE
            setOnClickListener { TailscaleHelp.open(this@SetupActivity) }
        }
        col.addView(tsButton)
        col.addView(label("No invite needed for independent mode. Shared-server mode uses a separate archive.", 16f, color(R.color.dim)).apply {
            (layoutParams as LinearLayout.LayoutParams).topMargin = dp(36)
        })
        return ScrollView(this).apply { addView(col); isFillViewport = true }
    }

    private fun TextView.accessibilityHeading() { if (android.os.Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true }

    private fun pasteAndGo() {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
        if (text.isNullOrBlank()) { say("Nothing copied yet. Open the invite message, press and hold it, choose Copy, then come back.", true); return }
        input.setText(text)
        go()
    }

    private fun say(msg: String, error: Boolean = false) {
        status.text = msg
        status.setTextColor(color(if (error) R.color.alert else R.color.ink))
    }

    /** Finds the invite (or camera pairing) link in whatever text was pasted, checks the server, saves it. */
    private fun go() {
        val link = Regex("https://[^\\s<>\"]+").find(input.text.toString())?.value?.trimEnd('.', ',', ')')
        if (link == null) { say("That doesn't look like an invite link. It should start with https://", true); return }
        val uri = Uri.parse(link)
        val origin = Prefs.originOf(link) ?: run { say("That link isn't a Spectacle invite.", true); return }
        val fragment = uri.fragment ?: ""
        val fp = Regex("[?&]fp=([0-9a-fA-F]{64})").find(fragment)?.groupValues?.get(1)?.lowercase()
        val cleanFragment = fragment.replace(Regex("[?&]fp=[0-9a-fA-F]{64}"), "")
        val path = (uri.path?.takeIf { it.isNotEmpty() } ?: "/") + (if (cleanFragment.isNotEmpty()) "#$cleanFragment" else "")

        connect.isEnabled = false
        say("Connecting…")
        Thread {
            val ok = try {
                Tls.client(fp).newCall(Request.Builder().url("$origin/api/state").build()).execute().use { it.isSuccessful }
            } catch (e: Exception) { false }
            main.post {
                connect.isEnabled = true
                if (!ok) {
                    if (TailscaleHelp.usesTailscale(origin)) {
                        say(TailscaleHelp.unreachableMessage(this, origin), true)
                        tsButton.text = TailscaleHelp.buttonLabel(this)
                        tsButton.visibility = View.VISIBLE
                    } else say("Couldn't reach your family's cameras. Check you're online (or on your home Wi-Fi), or ask for a new invite link.", true)
                    return@post
                }
                val prefs = Prefs(this)
                prefs.standalone = false
                prefs.server = origin
                prefs.pin = fp
                say("Connected!")
                startActivity(Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_PATH, path).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                finish()
            }
        }.start()
    }
}
