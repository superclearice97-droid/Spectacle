package app.spectacle.local

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Independent on-device archive. Nothing in this class opens a network connection. */
class LocalVault(context: Context) {
    val directory = File(context.filesDir, "standalone").apply { mkdirs() }
    private val index = AtomicFile(File(directory, "index.spx"))
    private val key: SecretKey = KeyStore.getInstance("AndroidKeyStore").run {
        load(null)
        (getKey("spectacle-local-v1", null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder("spectacle-local-v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    // All instances share one ordered disk queue (also handles recording finalization after Activity destruction).
    companion object {
        val io = Executors.newSingleThreadExecutor()
        val activeRecordings = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    }

    private fun encrypt(output: OutputStream): CipherOutputStream {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        output.write(cipher.iv.size); output.write(cipher.iv)
        return CipherOutputStream(output, cipher)
    }
    private fun decrypt(input: InputStream): CipherInputStream {
        try {
            val size = input.read(); require(size == 12) { "Invalid encrypted archive" }
            val iv = ByteArray(size); var offset = 0
            while (offset < size) { val n = input.read(iv, offset, size - offset); require(n > 0); offset += n }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)) }
            return CipherInputStream(input, cipher)
        } catch (e: Exception) { input.close(); throw e }
    }
    @Synchronized fun entries(): List<JSONObject> {
        if (!index.baseFile.exists() && !File(index.baseFile.path + ".bak").exists()) return emptyList()
        val data = decrypt(index.openRead()).use { it.readBytes().toString(Charsets.UTF_8) }
        val array = JSONArray(data)
        return (0 until array.length()).map { array.getJSONObject(it) }.sortedByDescending { it.getLong("time") }
    }
    private fun writeIndex(entries: List<JSONObject>) {
        val out = index.startWrite()
        try {
            // CipherOutputStream normally closes the AtomicFile stream. Buffer the small metadata index instead.
            val bytes = java.io.ByteArrayOutputStream()
            encrypt(bytes).use { it.write(JSONArray(entries).toString().toByteArray()) }
            out.write(bytes.toByteArray()); index.finishWrite(out)
        } catch (e: Exception) { index.failWrite(out); throw e }
    }
    @Synchronized fun save(source: InputStream, kind: String, title: String, detail: String = ""): JSONObject {
        val id = UUID.randomUUID().toString()
        val file = File(directory, "$id.spx")
        try { file.outputStream().use { out -> encrypt(out).use { source.copyTo(it) } } }
        catch (e: Exception) { file.delete(); throw e }
        val item = JSONObject().put("id", id).put("kind", kind).put("title", title).put("detail", detail).put("time", System.currentTimeMillis())
        try { writeIndex(listOf(item) + entries()) }
        catch (e: Exception) { file.delete(); throw e }
        prune(); return item
    }
    @Synchronized fun open(id: String): InputStream {
        require(Regex("[a-f0-9-]{36}").matches(id))
        return decrypt(File(directory, "$id.spx").inputStream())
    }
    @Synchronized fun remove(id: String) {
        val all = entries(); writeIndex(all.filter { it.getString("id") != id })
        if (Regex("[a-f0-9-]{36}").matches(id)) File(directory, "$id.spx").delete()
    }
    @Synchronized fun prune() {
        val all = entries().toMutableList()
        val removed = mutableListOf<JSONObject>()
        val cutoff = System.currentTimeMillis() - 7L * 86400000
        var total = all.sumOf { File(directory, it.getString("id") + ".spx").length() }
        while (all.isNotEmpty() && (all.last().getLong("time") < cutoff || total > 500L * 1024 * 1024)) {
            val item = all.removeAt(all.lastIndex); removed.add(item)
            total -= File(directory, item.getString("id") + ".spx").length()
        }
        if (removed.isNotEmpty()) { writeIndex(all); removed.forEach { File(directory, it.getString("id") + ".spx").delete() } }
        // Recover orphaned payloads if a process died between writing a payload and its index.
        val known = all.map { it.getString("id") + ".spx" }.toSet()
        directory.listFiles()?.filter { it.name != "index.spx" && it.extension == "spx" && it.name !in known }?.forEach { it.delete() }
    }
}
