package app.spectacle.local

import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LocalVaultTest {
    @Test fun encryptedArchiveSurvivesRestartAndRejectsTampering() {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val folder = File(base.cacheDir, "vault-test-${UUID.randomUUID()}").apply { mkdirs() }
        val context = object : ContextWrapper(base) { override fun getFilesDir(): File = folder }
        try {
            val vault = LocalVault(context)
            val payload = "private camera image".toByteArray()
            val item = vault.save(ByteArrayInputStream(payload), "photo", "Private title", "private details")
            val id = item.getString("id")
            val file = File(vault.directory, "$id.spx")
            assertFalse(file.readBytes().toString(Charsets.ISO_8859_1).contains("private camera image"))
            assertFalse(File(vault.directory, "index.spx").readBytes().toString(Charsets.ISO_8859_1).contains("Private title"))
            val reopened = LocalVault(context)
            assertEquals(id, reopened.entries().single().getString("id"))
            assertArrayEquals(payload, reopened.open(id).use { it.readBytes() })
            val corrupt = file.readBytes(); corrupt[corrupt.lastIndex] = (corrupt.last().toInt() xor 1).toByte(); file.writeBytes(corrupt)
            var rejected = false
            try { reopened.open(id).use { it.readBytes() } } catch (_: Exception) { rejected = true }
            assertTrue("AEAD must reject modified footage", rejected)
            reopened.remove(id)
            assertTrue(reopened.entries().isEmpty()); assertFalse(file.exists())
        } finally { folder.deleteRecursively() }
    }
    @Test fun bundledModelsIdentifyReferenceImageOffline() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        // Test assets are copied from the same repository fixtures used by the server smoke test.
        val bitmap = android.graphics.BitmapFactory.decodeStream(InstrumentationRegistry.getInstrumentation().context.assets.open("parrot.jpg"))
        LocalIdentifier(context).use { identifier ->
            val guesses = identifier.identify(bitmap)
            val bird = guesses.first { it.group == "bird" }
            assertEquals("Ara macao (Scarlet Macaw)", bird.label)
            assertTrue(bird.confidence > 0.6f)
        }
        bitmap.recycle()
    }
}
