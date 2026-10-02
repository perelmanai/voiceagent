package com.auralintel.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.text.format.DateFormat
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Streams speech activity and transcript revisions to the dashboard. Recognition
 * cycles remain separate from conversation turns, so a natural pause is not a stop.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var urlField: EditText
    private lateinit var codeField: EditText
    private lateinit var scanButton: Button
    private lateinit var micButton: Button
    private lateinit var statusText: TextView
    private lateinit var interimText: TextView
    private lateinit var logText: TextView
    private lateinit var logScroll: ScrollView

    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    private var stopping = false
    private var destroyed = false
    private var recognitionActive = false
    private var utteranceId = ""
    private var partialText = ""
    private var sequence = 0L
    private var newLogParagraph = true

    private val net: ExecutorService = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val restartRecognition = Runnable {
        if (listening && !destroyed) beginRecognition()
    }
    private val stopTimeout = Runnable {
        if (stopping) finishStop()
    }

    companion object {
        private const val PREFS = "aural_voice"
        private const val KEY_URL = "base_url"
        private const val KEY_CODE = "pair_code"
        private const val MIC_PERMISSION = 1001
        private const val TAG = "AuralVoice"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        urlField = findViewById(R.id.urlField)
        codeField = findViewById(R.id.codeField)
        scanButton = findViewById(R.id.scanButton)
        micButton = findViewById(R.id.micButton)
        statusText = findViewById(R.id.statusText)
        interimText = findViewById(R.id.interimText)
        logText = findViewById(R.id.logText)
        logScroll = findViewById(R.id.logScroll)

        urlField.setText(prefs.getString(KEY_URL, ""))
        codeField.setText(prefs.getString(KEY_CODE, ""))

        micButton.setOnClickListener {
            if (listening) stopListening() else startListening()
        }
        scanButton.setOnClickListener { scanQr() }
    }

    // --- QR pairing ------------------------------------------------------------

    /**
     * Launches the Play Services full-screen QR scanner (no camera permission needed)
     * and fills the URL + code from a payload of the form {"url":"...","code":"..."}.
     */
    private fun scanQr() {
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
        GmsBarcodeScanning.getClient(this, options)
            .startScan()
            .addOnSuccessListener { barcode ->
                val raw = barcode.rawValue
                if (raw.isNullOrBlank()) {
                    toast("Empty QR code.")
                    return@addOnSuccessListener
                }
                try {
                    val json = JSONObject(raw)
                    val url = json.optString("url").trim()
                    val pairCode = json.optString("code").trim()
                    if (url.isEmpty() || pairCode.isEmpty()) {
                        toast("QR code is missing the URL or code.")
                        return@addOnSuccessListener
                    }
                    urlField.setText(url)
                    codeField.setText(pairCode)
                    savePrefs()
                    status("Paired with $url — tap Start mic.")
                } catch (e: Exception) {
                    Log.e(TAG, "bad QR payload: $raw", e)
                    toast("That QR code isn't an Aural pairing code.")
                }
            }
            .addOnCanceledListener { status("Scan cancelled.") }
            .addOnFailureListener { e ->
                Log.e(TAG, "scan failed", e)
                toast("Scanner unavailable: ${e.message}")
            }
    }

    // --- Listening lifecycle ---------------------------------------------------

    private fun startListening() {
        if (listening || stopping || destroyed) return
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            status("Speech recognition is not available on this device.")
            return
        }
        if (baseUrl().isEmpty() || code().isEmpty()) {
            toast("Enter the dashboard URL and pairing code first.")
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this, arrayOf(Manifest.permission.RECORD_AUDIO), MIC_PERMISSION
            )
            return
        }

        savePrefs()
        setInputsEnabled(false)
        main.removeCallbacks(restartRecognition)
        main.removeCallbacks(stopTimeout)
        sequence = 0L
        newLogParagraph = true
        listening = true
        beginRecognition()
        updateButton()
        status("Listening…")
    }

    private fun stopListening() {
        if (!listening || stopping) return
        listening = false
        stopping = true
        main.removeCallbacks(restartRecognition)
        updateButton()
        status("Finishing your last words…")
        if (!recognitionActive) {
            finishStop()
            return
        }
        main.postDelayed(stopTimeout, 2000)
        try {
            // Unlike cancel(), this requests the final result for captured audio.
            recognizer?.stopListening()
        } catch (e: Exception) {
            Log.e(TAG, "stopListening failed", e)
            finishStop()
        }
    }

    private fun finishStop() {
        main.removeCallbacks(stopTimeout)
        main.removeCallbacks(restartRecognition)
        flushPartial()
        recognitionActive = false
        stopping = false
        send("stop", "")
        releaseRecognizer()
        interimText.text = ""
        setInputsEnabled(true)
        updateButton()
        status("Stopped")
    }

    private fun releaseRecognizer() {
        try {
            recognizer?.destroy()
        } catch (e: Exception) {
            Log.e(TAG, "destroy failed", e)
        }
        recognizer = null
    }

    private fun beginRecognition() {
        if (!listening || destroyed) return
        releaseRecognizer()
        utteranceId = UUID.randomUUID().toString()
        partialText = ""
        recognitionActive = true
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
            )
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.US.toString())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
        }
        try {
            // Capture the cycle ID in its listener so late callbacks cannot be
            // mistaken for revisions of the next recognition cycle.
            recognizer = SpeechRecognizer.createSpeechRecognizer(this).apply {
                setRecognitionListener(listenerFor(utteranceId))
            }
            recognizer?.startListening(intent)
        } catch (e: Exception) {
            recognitionActive = false
            Log.e(TAG, "startListening failed", e)
            restartSoon()
        }
    }

    /** Restart the recognizer to keep listening across utterances. */
    private fun restartSoon() {
        if (!listening) return
        main.removeCallbacks(restartRecognition)
        main.postDelayed(restartRecognition, 350)
    }

    private fun listenerFor(cycleId: String) = object : RecognitionListener {
        private fun isCurrent() =
            !destroyed && recognitionActive && cycleId == utteranceId

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {
            if (isCurrent()) send("activity", "")
        }
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}

        override fun onPartialResults(partialResults: Bundle?) {
            if (!isCurrent()) return
            val text = firstResult(partialResults) ?: return
            if (text.isNotBlank() && text != partialText) {
                partialText = text
                interimText.text = text
                send("partial", text)
            }
        }

        override fun onResults(results: Bundle?) {
            if (!isCurrent()) return
            recognitionActive = false
            interimText.text = ""
            val text = firstResult(results)
            if (!text.isNullOrBlank()) partialText = text
            val hadText = flushPartial()
            if (stopping) {
                finishStop()
            } else {
                if (!hadText) send("end", "")
                restartSoon()
            }
        }

        override fun onError(error: Int) {
            if (!isCurrent()) return
            recognitionActive = false
            val hadText = flushPartial()
            interimText.text = ""
            if (stopping) {
                finishStop()
                return
            }
            when (error) {
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> {
                    listening = false
                    finishStop()
                    status("Microphone permission is required.")
                }
                // No-match / timeout / busy are normal during continuous use — restart.
                else -> {
                    // A cough/no-match can emit activity without any transcript.
                    // Clear that activity without treating a pause as user Stop.
                    if (!hadText) send("end", "")
                    restartSoon()
                }
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun firstResult(b: Bundle?): String? =
        b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()

    private fun flushPartial(): Boolean {
        if (partialText.isBlank()) return false
        appendLine(partialText)
        send("final", partialText)
        partialText = ""
        return true
    }

    // --- Networking ------------------------------------------------------------

    /** Preserve event order and retry the identical IDs/body for server deduplication. */
    private fun send(type: String, text: String) {
        val base = baseUrl()
        val pairCode = code()
        val payload = JSONObject()
            .put("code", pairCode)
            .put("text", text)
            .put("type", type)
            .put("utteranceId", utteranceId)
            .put("sequence", ++sequence)
            .toString()
        net.execute {
            if (!postOnce(base, payload)) {
                if (!postOnce(base, payload)) {
                    main.post {
                        if (!destroyed) status("Send failed — check the URL and that the dashboard is reachable.")
                    }
                }
            }
        }
    }

    private fun postOnce(base: String, payload: String): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("$base/api/ingest").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 6000
                readTimeout = 6000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            val rc = conn.responseCode
            if (rc in 200..299) {
                main.post { if (listening && !destroyed) status("Connected ✓  ·  listening…") }
                true
            } else {
                Log.w(TAG, "ingest returned $rc")
                false
            }
        } catch (e: Exception) {
            Log.e(TAG, "post failed", e)
            false
        } finally {
            conn?.disconnect()
        }
    }

    // --- Helpers ---------------------------------------------------------------

    private fun baseUrl(): String {
        var u = urlField.text.toString().trim().trimEnd('/')
        if (u.isEmpty()) return u
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
            // Local/LAN dashboards run plain HTTP; defaulting to https breaks pairing.
            val host = u.substringBefore(':').substringBefore('/')
            val isLocal = host == "localhost" ||
                host == "127.0.0.1" ||
                host.startsWith("10.") ||
                host.startsWith("192.168.") ||
                host.matches(Regex("^172\\.(1[6-9]|2\\d|3[01])\\..*"))
            u = if (isLocal) "http://$u" else "https://$u"
        }
        return u
    }

    private fun code(): String = codeField.text.toString().trim().uppercase(Locale.US)

    private fun savePrefs() {
        prefs.edit()
            .putString(KEY_URL, baseUrl())
            .putString(KEY_CODE, code())
            .apply()
    }

    private fun appendLine(text: String) {
        val ts = DateFormat.format("HH:mm:ss", Date()).toString()
        val existing = logText.text
        logText.text = when {
            existing.isNullOrEmpty() -> "[$ts] $text"
            newLogParagraph -> "$existing\n[$ts] $text"
            else -> "$existing $text"
        }
        newLogParagraph = false
        logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    private fun updateButton() {
        micButton.text = if (stopping) "Finishing…" else if (listening) "Stop" else "Start mic"
        micButton.isEnabled = !stopping
    }

    private fun setInputsEnabled(enabled: Boolean) {
        urlField.isEnabled = enabled
        codeField.isEnabled = enabled
        scanButton.isEnabled = enabled
    }

    private fun status(msg: String) {
        statusText.text = msg
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == MIC_PERMISSION) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startListening()
            } else {
                status("Microphone permission denied.")
            }
        }
    }

    override fun onDestroy() {
        main.removeCallbacks(restartRecognition)
        main.removeCallbacks(stopTimeout)
        if (listening || stopping) {
            // An Activity teardown cannot wait for another recognition callback.
            // Queue the last visible words before the stop event, then drain sends.
            flushPartial()
            send("stop", "")
        }
        listening = false
        stopping = false
        recognitionActive = false
        destroyed = true
        releaseRecognizer()
        net.shutdown()
        super.onDestroy()
    }
}
