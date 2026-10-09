package app.spectacle

import android.net.http.SslCertificate
import android.os.Build
import okhttp3.OkHttpClient
import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Trust rules: a certificate is accepted if Android trusts it normally (Tailscale, real domains),
 * OR if it is exactly the self-signed certificate whose fingerprint came in the invite link.
 * Nothing else is ever accepted.
 */
object Tls {
    fun fingerprint(cert: X509Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }

    fun x509(cert: SslCertificate): X509Certificate? {
        if (Build.VERSION.SDK_INT >= 29) return cert.x509Certificate
        val bytes = SslCertificate.saveState(cert).getByteArray("x509-certificate") ?: return null
        return CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(bytes)) as X509Certificate
    }

    private fun systemTrust(): X509TrustManager {
        val f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        f.init(null as KeyStore?)
        return f.trustManagers.first { it is X509TrustManager } as X509TrustManager
    }

    fun trustManager(pin: String?): X509TrustManager {
        val sys = systemTrust()
        return object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) = sys.checkClientTrusted(chain, authType)
            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
                try { sys.checkServerTrusted(chain, authType) } catch (e: CertificateException) {
                    if (pin == null || chain.isEmpty() || fingerprint(chain[0]) != pin) throw e
                }
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = sys.acceptedIssuers
        }
    }

    fun client(pin: String?): OkHttpClient {
        val tm = trustManager(pin)
        val ctx = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }
        val defaultVerifier = HttpsURLConnection.getDefaultHostnameVerifier()
        return OkHttpClient.Builder()
            .sslSocketFactory(ctx.socketFactory, tm)
            .hostnameVerifier { host, session ->
                defaultVerifier.verify(host, session) ||
                    (pin != null && (session.peerCertificates.firstOrNull() as? X509Certificate)?.let { fingerprint(it) == pin } == true)
            }
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(30, TimeUnit.SECONDS)
            .build()
    }
}
