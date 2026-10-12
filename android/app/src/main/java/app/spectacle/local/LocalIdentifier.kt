package app.spectacle.local

import android.content.Context
import android.graphics.Bitmap
import org.tensorflow.lite.Interpreter
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Runs the repository's three bundled uint8 iNaturalist models on this phone, offline. */
class LocalIdentifier(private val context: Context) : AutoCloseable {
    data class Guess(val label: String, val group: String, val confidence: Float)
    private data class Model(val interpreter: Interpreter, val labels: List<String>)
    private val models = mutableMapOf<String, Model>()
    fun identify(bitmap: Bitmap): List<Guess> {
        val scaled = Bitmap.createScaledBitmap(bitmap, 224, 224, true)
        val pixels = IntArray(224 * 224); scaled.getPixels(pixels, 0, 224, 0, 0, 224, 224)
        val input = ByteBuffer.allocateDirect(pixels.size * 3).order(ByteOrder.nativeOrder())
        pixels.forEach { input.put((it shr 16 and 255).toByte()); input.put((it shr 8 and 255).toByte()); input.put((it and 255).toByte()) }
        if (scaled !== bitmap) scaled.recycle()
        val guesses = mutableListOf<Guess>()
        for (group in listOf("insect", "plant", "bird")) {
            val model = models.getOrPut(group) {
                val bytes = context.assets.open("models/mobilenet_v2_1.0_224_inat_${group}_quant.tflite").use { it.readBytes() }
                val buffer = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).apply { put(bytes); rewind() }
                Model(Interpreter(buffer, Interpreter.Options().setNumThreads(2)), context.assets.open("models/inat_${group}_labels.txt").bufferedReader().use { it.readLines().map(String::trim) })
            }
            val tensor = model.interpreter.getOutputTensor(0)
            val output = ByteBuffer.allocateDirect(tensor.numBytes()).order(ByteOrder.nativeOrder())
            input.rewind(); model.interpreter.run(input, output); output.rewind()
            val quant = tensor.quantizationParams()
            val count = tensor.shape().last()
            val best = (0 until count).map { i ->
                val probability = if (tensor.dataType() == org.tensorflow.lite.DataType.FLOAT32) output.float else ((output.get().toInt() and 255) - quant.zeroPoint) * quant.scale
                Guess(model.labels.getOrElse(i) { "background" }, group, probability)
            }.filter { it.label.isNotBlank() && it.label != "background" }.maxByOrNull { it.confidence }
            if (best != null) guesses.add(best)
        }
        return guesses.sortedByDescending { it.confidence }
    }
    override fun close() { models.values.forEach { it.interpreter.close() }; models.clear() }
}
